import { randomUUID } from 'node:crypto';
import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionEventCursor, SessionRef, WorkspaceRef } from '@cantelop/sdk';
import { readRemoteConfiguration } from './git-remotes.js';
import { ancestor, cleanRepository, createUpload, fileInfo, git, gitText, sha256, type Repository } from './git.js';
import { MAX_TRANSFER_BYTES, UPLOAD_CHUNK_BYTES, validOid, validTransferId, validateExportManifest, type GitCommand, type GitResult, type GitStatus, type ExportManifest, type FileInfo } from './git-protocol.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from './protocol.js';
import type { selectProject } from './project.js';
import { backoffMs, isTransient, messageId } from './transport.js';

export type GitWorkspace = Pick<WorkspaceRef<TerminalCommand, TerminalEvent, TerminalReply>, 'session'>;
type Project = Awaited<ReturnType<typeof selectProject>>;
type Action = GitCommand extends infer C ? C extends GitCommand ? Omit<C, 'type' | 'directoryName' | 'binding'> : never : never;

/** Retire only this attachment's observed checkout registrations after stopping. */
export function createGitSession(workspace: GitWorkspace & Pick<WorkspaceRef<TerminalCommand>, 'database'>, project: Pick<Project, 'directoryName'>, id?: string,managedStop?:(session:string)=>Promise<void>): Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'id' | 'request' | 'dispatch' | 'stream' | 'view' | 'stop'> {
  const session = workspace.session({ keepAliveSeconds: 120, ...(id ? { id } : {}) });
  let stopping: Promise<void> | undefined;
  const open = () => { if (stopping) throw new Error('This Git session has stopped. Start a new session.'); };
  return {
    id: session.id,
    request(message, options) { open(); return session.request(message, options); },
    dispatch(message, options) { open(); return session.dispatch(message, options); },
    stream(options) { return session.stream(options); },
    view(options) { return session.view(options); },
    stop() {
      return stopping ??= (async () => {
        if(managedStop){await managedStop(session.id);return;}
        const snapshot = (async () => {
          const db = await workspace.database();
          const rows = await db.execute({ sql: 'SELECT token FROM juiced_checkout_leases WHERE project = ? AND session = ?', args: [project.directoryName, session.id] });
          return { db, rows };
        })();
        const { db, rows } = await snapshot.finally(() => session.stop());
        // A new attachment may already have reopened this logical identity.
        // Its newly acquired tokens must survive the old attachment's cleanup.
        for (const row of rows.rows) await db.execute({ sql: 'DELETE FROM juiced_checkout_leases WHERE project = ? AND session = ? AND token = ?', args: [project.directoryName, session.id, String(row.token)] });
      })();
    },
  };
}

export class GitWorkspaceClient {
  private session;
  private get namespace() {return this.project.scope?`${sha256(this.project.scope).slice(0,24)}/${this.project.workspace}`:this.project.workspace;}
  constructor(private workspace: GitWorkspace, private project: Project, private repository: Repository, private signal: AbortSignal) {
    this.session = workspace.session({ keepAliveSeconds: 120 });
  }

  async call(action: Action): Promise<GitResult> {
    const command = { ...action, type: 'git', directoryName: this.project.directoryName, binding: this.repository.binding } as GitCommand;
    let id = messageId();
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      let reply: TerminalReply;
      try { reply = await this.session.request(command, { id, signal: this.signal, timeoutMs: 240_000 }); }
      catch (error) {
        if (this.signal.aborted || attempt >= 2 || !isTransient(error)) throw error;
        await delay(backoffMs(attempt), undefined, { signal: this.signal }); continue;
      }
      if (!reply?.ok) {
        if (reply && reply.stale?.length && action.action !== 'reap' && attempt < 2) {
          // An expired timestamp is not permission to reuse a live checkout.
          // Stop the recorded owners before removing their exact stale tokens.
          for (const lease of reply.stale) await this.workspace.session({ id: lease.session }).stop();
          await this.call({ action: 'reap', leases: reply.stale });
          return this.call(action);
        }
        if (reply?.busy === 'maintenance' && Date.now() - startedAt < 240_000) {
          await delay(500, undefined, { signal: this.signal });
          id = messageId();
          continue;
        }
        if (reply && /database_not_ready/.test(reply.error) && Date.now() - startedAt < 120_000) {
          await delay(1000, undefined, { signal: this.signal });
          id = messageId();
          continue;
        }
        throw new Error(reply && 'error' in reply ? reply.error : 'The Git workspace rejected the command');
      }
      return reply.git ?? {};
    }
  }

  async status(): Promise<GitStatus> {
    const result = await this.call({ action: 'status' });
    if (!result.status) throw new Error('The runtime returned no Git workspace status');
    return result.status;
  }

  async send(includeUncommitted: boolean, initializeOnly = false) {
    const status = await this.status();
    const configuration = await readRemoteConfiguration(this.repository.root, this.repository.branch);
    if (initializeOnly && status.initialized) { await this.call({ action: 'configure', configuration }); return; }
    const upload = await createUpload(this.repository, includeUncommitted, status.head, this.signal);
    try {
      if (upload.manifest.files.reduce((sum, file) => sum + file.size, 0) > MAX_TRANSFER_BYTES) throw new Error('Git transfer exceeds the 512 MiB limit');
      await this.call({ action: 'begin', id: upload.id, manifest: upload.manifest });
      for (const info of upload.manifest.files) {
        const file = await open(join(upload.directory, info.name), 'r');
        try {
          const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES);
          for (let offset = 0; offset < info.size;) {
            const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, info.size - offset), offset);
            if (!bytesRead) throw new Error('The prepared Git transfer was truncated');
            const result = await this.call({ action: 'chunk', id: upload.id, file: info.name, offset, data: bytes.subarray(0, bytesRead).toString('base64') });
            offset += bytesRead;
            if (result.offset !== offset) throw new Error('The remote Git upload returned an unexpected offset');
          }
        } finally { await file.close(); }
      }
      await this.call({ action: 'apply', id: upload.id, initializeOnly });
      await this.call({ action: 'configure', configuration });
      await this.call({ action: 'cleanup', id: upload.id });
    } finally { await upload.close(); }
  }

  private async download(id: string, path: string, info: FileInfo, selected: 'bundle' | 'snapshot' = 'bundle') {
    const file = await open(path, 'w+', 0o600);
    let offset = 0; let cursor: SessionEventCursor | undefined; let complete = false; let failures = 0;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const requested = this.call({ action: 'download', id, offset: 0, ...(selected === 'snapshot' ? { file: selected } : {}) }).catch(error => { controller.abort(error); throw error; });
    void requested.catch(() => {});
    try {
      while (!complete) {
        try {
          for await (const event of this.session.stream({ ...(cursor ? { after: cursor } : {}), signal })) {
            const data = event.data;
            if (data.type === 'git-error' && data.id === id) throw new Error(`Remote Git download failed: ${data.message}`);
            if (data.type === 'git-chunk' && data.id === id && (data.file ?? 'bundle') === selected) {
              const bytes = Buffer.from(data.data, 'base64');
              if (data.offset !== offset || offset + bytes.length > info.size) throw new Error('The remote Git download is out of order');
              await file.writeFile(bytes); offset += bytes.length;
            }
            if (data.type === 'git-end' && data.id === id && (data.file ?? 'bundle') === selected) {
              if (offset !== info.size || data.size !== offset || data.sha256 !== info.sha256) throw new Error('The remote Git download is incomplete');
              complete = true;
            }
            cursor = event.cursor;
            failures = 0;
            if (complete) break;
          }
          if (!complete) throw new Error('The Git download stream ended unexpectedly');
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (this.signal.aborted || !isTransient(error) || ++failures > 3) throw error;
          await delay(backoffMs(failures), undefined, { signal: this.signal });
        }
      }
      await requested;
    } finally { await file.close(); }
    const actual = await fileInfo(path, selected);
    if (actual.size !== info.size || actual.sha256 !== info.sha256) throw new Error('Git download checksum verification failed');
  }

  async receive(prepared?: { id: string; manifest: ExportManifest }): Promise<{ head: string; sourceBranch: string | null; ref: string; patch?: Buffer }> {
    const id = prepared?.id ?? randomUUID();
    if (!validTransferId(id)) throw new Error('Invalid Git transfer identity');
    const directory = await mkdtemp(join(tmpdir(), 'juiced-import-'));
    try {
      const manifest = prepared?.manifest ?? (await this.call({ action: 'export', id, known: this.repository.head })).manifest;
      if (!manifest) throw new Error('Missing Git export manifest');
      validateExportManifest(manifest);
      const bundle = join(directory, 'bundle');
      await this.download(id, bundle, manifest.file);
      await git(this.repository.root, ['bundle', 'verify', bundle], { signal: this.signal });
      const prefix = `refs/juiced/exports/${id}`;
      const refs = (await gitText(this.repository.root, ['bundle', 'list-heads', bundle])).split('\n');
      if (!refs.includes(`${manifest.head} ${prefix}/head`)) throw new Error('The imported bundle does not match its declared HEAD');
      const archive = `refs/juiced/imports/${this.namespace}/${id}`;
      // Keep an immutable import ref even when remote branches have been rewritten.
      const extra = manifest.snapshot ? [`${prefix}/baseline:${archive}/baseline`, `${prefix}/snapshot:${archive}/snapshot`] : [];
      await git(this.repository.root, ['fetch', '--atomic', '--no-tags', bundle, `${prefix}/head:${archive}/head`, `${prefix}/branches/*:${archive}/branches/*`, ...extra], { signal: this.signal });
      let patch: Buffer | undefined;
      if (manifest.snapshot) {
        if (await gitText(this.repository.root, ['rev-parse', `${archive}/baseline^{tree}`]) !== manifest.snapshot.baseTree ||
            await gitText(this.repository.root, ['rev-parse', `${archive}/snapshot^{tree}`]) !== manifest.snapshot.tree) throw new Error('The snapshot bundle does not contain its declared trees');
        const path = join(directory, 'snapshot');
        await this.download(id, path, manifest.snapshot.file, 'snapshot');
        patch = await readFile(path);
        const env = { GIT_INDEX_FILE: join(directory, 'verification-index') };
        const verify = (args: string[], input?: Buffer) => git(this.repository.root, args, { env, signal: this.signal, ...(input ? { input } : {}) });
        await verify(['read-tree', manifest.snapshot.baseTree]);
        if (patch.length) await verify(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch);
        if ((await verify(['write-tree'])).toString().trim() !== manifest.snapshot.tree) throw new Error('The snapshot patch does not match the imported trees');
      }
      const ref = `refs/remotes/juiced/${this.namespace}/HEAD`;
      const updates = [`update ${ref} ${manifest.head}`];
      for (const line of refs) {
        const [oid, name] = line.split(' ');
        if (name?.startsWith(`${prefix}/branches/`) && validOid(oid)) updates.push(`update refs/remotes/juiced/${this.namespace}/${name.slice(`${prefix}/branches/`.length)} ${oid}`);
      }
      await git(this.repository.root, ['update-ref', '--stdin'], { input: updates.join('\n') + '\n', signal: this.signal });
      if (!prepared) await this.call({ action: 'cleanup', id });
      return { head: manifest.head, sourceBranch: manifest.sourceBranch, ref, ...(patch ? { patch } : {}) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async fastForward() {
    const imported = await this.receive();
    const branch = await gitText(this.repository.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
    if (!branch || branch !== imported.sourceBranch || branch !== this.repository.branch) throw new Error(`Commits imported into ${imported.ref}. Check out the workspace's source branch before fast-forwarding.`);
    if (await gitText(this.repository.root, ['rev-parse', 'HEAD']) !== this.repository.head) throw new Error('Commits were imported, but local HEAD changed during the import. Retry fast-forward.');
    if (!await cleanRepository(this.repository.root)) throw new Error(`Commits imported into ${imported.ref}. The local checkout must be clean before fast-forwarding.`);
    if (!await ancestor(this.repository.root, this.repository.head, imported.head)) throw new Error(`Commits imported into ${imported.ref}. Local and remote histories diverged; reconcile them with Git.`);
    await git(this.repository.root, ['merge', '--ff-only', '--no-overwrite-ignore', imported.head], { signal: this.signal });
    return imported;
  }

  async close() { await this.session.stop(); }
}
