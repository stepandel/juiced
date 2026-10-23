import { link, lstat, mkdir, mkdtemp, open, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { SessionHarnessContext } from '@cantelop/sdk/session';
import { fileInfo, sha256 } from '../git.js';
import { isENOENT } from '../fs-util.js';
import { checkedLocalPath } from '../local-files.js';
import { LOCAL_FILE_CHUNK_BYTES, validateLocalFileManifest, type LocalFileInfo, type LocalFilesCommand, type LocalFilesRequest } from '../local-files-protocol.js';
import { BASE64 } from '../protocol.js';
import type { PublishResult } from '../publish-protocol.js';
import { acquireCheckout } from './project-state.js';
import { projectPaths, readBinding } from './git.js';

/** Stage approved bytes, verify them, then install files without overwriting any path. */
export class LocalFileReceiver {
  private directory?: string;
  private files?: LocalFileInfo[];
  private received: Set<number>[] = [];
  private work: Promise<unknown> = Promise.resolve();
  constructor(private context: SessionHarnessContext, private options: { workspace: string; directoryName: string; binding: string }, private request: Extract<LocalFilesRequest, { action: 'pull' }>, private signal: AbortSignal) {}

  input(command: LocalFilesCommand): Promise<void> {
    const next = this.work.then(async () => {
      this.signal.throwIfAborted();
      if (Date.now() >= this.request.expiresAt) throw new Error('The local file request expired.');
      if (command.action === 'begin') {
        validateLocalFileManifest(command.files, this.request);
        if (this.files) {
          if (JSON.stringify(this.files) !== JSON.stringify(command.files)) throw new Error('Conflicting local file manifest retry.');
          return;
        }
        const paths = await projectPaths(this.options.workspace, this.options.directoryName);
        const directory = await mkdtemp(join(paths.metadata, 'local-files-'));
        try {
          // The private staging directory keeps these unreadable until linked; the umask sets their installed modes.
          for (const [index, file] of command.files.entries()) await writeFile(join(directory, String(index)), '', { flag: 'wx', mode: file.executable ? 0o777 : 0o666 });
        } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
        this.directory = directory;
        this.files = structuredClone(command.files);
        this.received = command.files.map(() => new Set());
        return;
      }
      if (command.action !== 'chunk' || !this.files || !this.directory || !Number.isSafeInteger(command.index) || command.index < 0 || !this.files[command.index] ||
          !Number.isSafeInteger(command.offset) || command.offset < 0 || typeof command.data !== 'string' || !command.data.length ||
          command.data.length > Math.ceil(LOCAL_FILE_CHUNK_BYTES / 3) * 4 || !BASE64.test(command.data)) throw new Error('Invalid local file chunk.');
      const data = Buffer.from(command.data, 'base64'), info = this.files[command.index]!;
      // Chunks are aligned and full-sized, so they may arrive in any order while the client pipelines them.
      if (command.offset % LOCAL_FILE_CHUNK_BYTES || data.length !== Math.min(LOCAL_FILE_CHUNK_BYTES, info.size - command.offset)) throw new Error('Invalid local file chunk.');
      const chunk = command.offset / LOCAL_FILE_CHUNK_BYTES, received = this.received[command.index]!;
      const file = await open(join(this.directory, String(command.index)), 'r+');
      try {
        if (received.has(chunk)) {
          const previous = Buffer.alloc(data.length);
          const read = await file.read(previous, 0, previous.length, command.offset);
          if (read.bytesRead !== data.length || !previous.equals(data)) throw new Error('Conflicting local file chunk retry.');
        } else {
          for (let offset = 0; offset < data.length;) {
            const write = await file.write(data, offset, data.length - offset, command.offset + offset);
            if (!write.bytesWritten) throw new Error('Local file upload made no progress.');
            offset += write.bytesWritten;
          }
          received.add(chunk);
        }
      } finally { await file.close(); }
    });
    this.work = next.catch(() => {});
    return next;
  }

  async apply(): Promise<PublishResult> {
    await this.work;
    if (!this.files || !this.directory) throw new Error('No approved local files were uploaded.');
    const paths = await projectPaths(this.options.workspace, this.options.directoryName);
    const controller = new AbortController(), signal = AbortSignal.any([this.signal, controller.signal]);
    const lease = await acquireCheckout(await this.context.database(), this.options.directoryName, this.context.session.id, 'maintenance', error => controller.abort(error), true);
    const installed: { path: string; index: number }[] = [], created: { first: string; last: string }[] = [];
    try {
      const binding = await readBinding(paths.metadata);
      if (binding?.binding !== this.options.binding) throw new Error('The remote repository binding changed.');
      const targets: { path: string; index: number; exists: boolean }[] = [];
      for (const [index, info] of this.files.entries()) {
        signal.throwIfAborted();
        const actual = await fileInfo(join(this.directory, String(index)), 'bundle');
        if (actual.size !== info.size || actual.sha256 !== info.sha256) throw new Error(`Incomplete or corrupt local file: ${info.path}`);
        const name = this.request.destination === '.' ? info.path : `${this.request.destination}/${info.path}`;
        const target = await checkedLocalPath(paths.target, name, true);
        let exists = false;
        try {
          const stat = await lstat(target);
          if (!stat.isFile() || stat.size !== info.size || !!(stat.mode & 0o111) !== info.executable || sha256(await readFile(target)) !== info.sha256)
            throw new Error(`Remote file already exists with different contents or mode: ${name}. Choose a different destination.`);
          exists = true;
        } catch (error) { if (!isENOENT(error)) throw error; }
        targets.push({ path: target, index, exists });
      }
      // Preflight every target before installing any bytes. Hard links refuse races with existing files.
      for (const target of targets) {
        signal.throwIfAborted();
        if (Date.now() >= this.request.expiresAt) throw new Error('The local file request expired.');
        if (target.exists) continue;
        await checkedLocalPath(paths.target, relative(paths.target, target.path), true);
        const first = await mkdir(dirname(target.path), { recursive: true });
        if (first) created.push({ first, last: dirname(target.path) });
        await checkedLocalPath(paths.target, relative(paths.target, target.path), true);
        await link(join(this.directory, String(target.index)), target.path);
        installed.push(target);
      }
      return { status: installed.length ? 'applied' : 'already-applied', message: `Pulled ${this.files.length} approved local files into ${this.request.destination}. Git HEAD and index are unchanged.` };
    } catch (error) {
      // Remove only links we installed and still own. Never remove a concurrent replacement.
      for (const target of installed.reverse()) {
        try {
          const current = await lstat(target.path), staged = await lstat(join(this.directory, String(target.index)));
          if (current.ino === staged.ino && current.dev === staged.dev) await unlink(target.path);
        } catch { /* Retain files if a concurrent writer changed their identity. */ }
      }
      // Remove directories this pull created, deepest first; rmdir keeps any that another writer filled.
      for (const { first, last } of created.reverse()) {
        for (let directory = last; ; directory = dirname(directory)) {
          try { await rmdir(directory); } catch { break; }
          if (directory === first) break;
        }
      }
      throw error;
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    await this.work;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
