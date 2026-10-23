import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './git.js';
import { localFilePath, LOCAL_FILE_CHUNK_BYTES, LOCAL_LIST_PAGE, MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILES, MAX_LOCAL_FILES_BYTES, MAX_LOCAL_RESULT_BYTES, validateLocalFileManifest, validateLocalFilesRequest, type LocalFileInfo, type LocalFileListing, type LocalFilesPayload, type LocalFilesRequest } from './local-files-protocol.js';
import type { PublishResult } from './publish-protocol.js';
import type { TerminalReply } from './protocol.js';

/** Check every component: symlinks must never turn a project path into host access. */
export async function checkedLocalPath(root: string, path: string, missing = false): Promise<string> {
  if (!localFilePath(path, true)) throw new Error('Use a project-relative path outside .git.');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new Error('The project root changed or is unsafe.');
  let target = root;
  for (const part of path === '.' ? [] : path.split('/')) {
    target = join(target, part);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Symlink paths cannot be transferred: ${path}`);
      if (info.isDirectory()) {
        try { await lstat(join(target, '.git')); throw new Error(`Nested repositories cannot be transferred: ${path}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}

/** Concurrent chunk requests: one round trip per 48 KiB would not fit 64 MiB in the deadline. */
const LOCAL_FILE_WINDOW = 8;
/** Room left in a listing result for its status, message and directory path. */
const LISTING_BUDGET = MAX_LOCAL_RESULT_BYTES - 8 * 1024;

type Prepared = { listing?: LocalFileListing; files?: LocalFileInfo[]; contents?: Buffer[] };
export class LocalFiles {
  private prepared = new Map<string, Prepared>();
  constructor(private root: string) {}

  async prepare(request: LocalFilesRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    validateLocalFilesRequest(request); signal.throwIfAborted();
    await this.discard(request.id);
    if (request.action === 'list') {
      const directory = await checkedLocalPath(this.root, request.path);
      const names: string[] = [];
      const iterator = await opendir(directory);
      for await (const entry of iterator) {
        signal.throwIfAborted();
        if (entry.name.toLowerCase() === '.git' || !request.includeHidden && entry.name.startsWith('.')) continue;
        names.push(entry.name);
        if (names.length > 4096) throw new Error('This directory has too many entries. Select a smaller directory.');
      }
      names.sort();
      const entries = [];
      let size = 0;
      for (const name of names.slice(request.offset, request.offset + LOCAL_LIST_PAGE)) {
        signal.throwIfAborted();
        const path = request.path === '.' ? name : `${request.path}/${name}`;
        if (!localFilePath(path)) throw new Error('This directory contains an unsupported filename.');
        const info = await lstat(join(directory, name));
        const entry = { path, kind: info.isSymbolicLink() ? 'symlink' as const : info.isFile() ? 'file' as const : info.isDirectory() ? 'directory' as const : 'other' as const, size: info.size };
        // Long multibyte paths shorten the page; nextOffset continues after the last entry that fits.
        size += Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (entries.length && size > LISTING_BUDGET) break;
        entries.push(entry);
      }
      const listing: LocalFileListing = { path: request.path, entries, ...(request.offset + entries.length < names.length ? { nextOffset: request.offset + entries.length } : {}) };
      signal.throwIfAborted();
      this.prepared.set(request.id, { listing });
      return { directory: this.root, path: request.path, includeHidden: request.includeHidden, offset: request.offset, entries: entries.length, access: 'Share names, types and sizes only; no file contents.' };
    }
    // Approved bytes stay in memory: no plaintext copy outlives this process.
    const files: LocalFileInfo[] = [], contents: Buffer[] = [], seen = new Set<string>();
    let bytes = 0, visited = 0;
    const capture = async (path: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (++visited > 4096 || depth > 32) throw new Error('Too many local paths. Select a smaller directory.');
      const target = await checkedLocalPath(this.root, path);
      const info = await lstat(target);
      if (info.isDirectory()) {
        const iterator = await opendir(target);
        for await (const entry of iterator) await capture(`${path}/${entry.name}`, depth + 1);
        return;
      }
      if (!info.isFile()) throw new Error(`Only regular files and directories can be pulled: ${path}`);
      if (seen.has(path)) return;
      if (files.length >= MAX_LOCAL_FILES) throw new Error('A pull is limited to 256 files.');
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > MAX_LOCAL_FILE_BYTES || bytes + before.size > MAX_LOCAL_FILES_BYTES) throw new Error('Local file limits: 16 MiB per file and 64 MiB per pull.');
        const data = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < data.length) {
          signal.throwIfAborted();
          const read = await file.read(data, length, data.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await file.stat();
        if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Local file changed during capture: ${path}`);
        const pinned = data.subarray(0, length);
        contents.push(pinned);
        files.push({ path, size: length, sha256: sha256(pinned), executable: !!(before.mode & 0o111) });
        seen.add(path); bytes += length;
      } finally { await file.close(); }
    };
    for (const path of request.paths) await capture(path, 0);
    if (!files.length) throw new Error('The selected paths contain no regular files to pull.');
    validateLocalFileManifest(files, request); signal.throwIfAborted();
    this.prepared.set(request.id, { files, contents });
    return { directory: this.root, requestedPaths: request.paths, destination: request.destination, files: files.length, paths: files.map(file => file.path), bytes, ignoredFiles: 'Explicitly selected hidden and ignored files are included.', existingFiles: 'Different remote files will be refused.' };
  }

  async send(request: LocalFilesRequest, signal: AbortSignal, send: (command: LocalFilesPayload) => Promise<TerminalReply>): Promise<PublishResult> {
    const prepared = this.prepared.get(request.id);
    if (!prepared) throw new Error('The approved local files are no longer available. Request them again.');
    signal.throwIfAborted();
    if (request.action === 'list') return { status: 'applied', message: 'Listed the approved local directory.', listing: prepared.listing! };
    const call = async (command: Parameters<typeof send>[0]) => {
      signal.throwIfAborted();
      const reply = await send(command);
      if (!reply.ok) throw new Error(reply.error);
    };
    await call({ type: 'publish-files', id: request.id, action: 'begin', files: prepared.files! });
    const contents = prepared.contents!;
    const chunks = contents.flatMap((data, index) => Array.from({ length: Math.ceil(data.length / LOCAL_FILE_CHUNK_BYTES) }, (_, chunk) => ({ index, offset: chunk * LOCAL_FILE_CHUNK_BYTES })));
    let next = 0, failed = false;
    const worker = async () => {
      try {
        while (!failed && next < chunks.length) {
          const { index, offset } = chunks[next++]!;
          await call({ type: 'publish-files', id: request.id, action: 'chunk', index, offset, data: contents[index]!.subarray(offset, offset + LOCAL_FILE_CHUNK_BYTES).toString('base64') });
        }
      } catch (error) { failed = true; throw error; }
    };
    await Promise.all(Array.from({ length: LOCAL_FILE_WINDOW }, worker));
    return { status: 'applied', message: 'Uploaded the approved files; awaiting remote application.' };
  }

  async discard(id: string): Promise<void> {
    this.prepared.delete(id);
  }
}
