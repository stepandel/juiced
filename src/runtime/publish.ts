import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionHarnessContext } from '@cantelop/sdk/session';
import { git, gitText } from '../git.js';
import { validOid, validTransferId } from '../git-protocol.js';
import { PUBLISH_TIMEOUT_MS, publishSucceeded, validatePublishResult, type LocalTransfer, type PublishCommand, type PublishResult, type UploadRequest } from '../publish-protocol.js';
import type { TerminalEvent } from '../protocol.js';
import { atomicJSON } from '../fs-util.js';
import { createGitRuntime, projectPaths, readBinding } from './git.js';
import { applyLocalUpload } from './local-upload.js';
import { publishMcpConfiguration } from './publish-mcp.js';
import { validateLocalFilesRequest, type LocalFilesRequest } from '../local-files-protocol.js';
import { LocalFileReceiver } from './local-files.js';

type Pending = { publication: LocalTransfer; controller: AbortController; receiver?: LocalFileReceiver; owner?: string; completion?: { fingerprint: string; work: Promise<PublishResult> }; resolve(result: PublishResult): void };
type BridgeRequest = { name: string; summary: string; head?: string; includeUncommitted?: boolean; path?: string; includeHidden?: boolean; offset?: number; paths?: string[]; destination?: string };

/** Remote stdio tools use a private Unix socket; only authenticated SDK clients can claim/apply. */
export async function createPublishBridge(context: SessionHarnessContext, options: {
  workspace: string; directoryName: string; binding: string; known: string; relativeDirectory?: string;
  send(event: TerminalEvent): Promise<void>;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'jp-'));
  const socketPath = join(directory, 'mcp');
  const pending = new Map<string, Pending>();
  const finished = new Map<string, { owner: string; fingerprint: string; result: PublishResult }>();
  const sockets = new Set<Socket>();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const runtime = createGitRuntime({ ...context, signal }, options.workspace);
  const tasks = new Set<Promise<void>>();
  const paths = await projectPaths(options.workspace, options.directoryName);
  const db = await context.database();
  await db.execute('CREATE TABLE IF NOT EXISTS juiced_publication_leases (project TEXT PRIMARY KEY, id TEXT NOT NULL, expires INTEGER NOT NULL)');
  let closed = false, preparing = false;
  const release = async (id: string) => { await db.execute({ sql: 'DELETE FROM juiced_publication_leases WHERE project = ? AND id = ?', args: [options.directoryName, id] }); };

  async function publish(request: BridgeRequest, connection: Socket): Promise<PublishResult> {
    if (closed || preparing || pending.size) throw new Error('Another local publication is still pending.');
    const fields: Record<string, string[]> = { publish_commits: ['head'], publish_snapshot: [], pull_local_changes: ['includeUncommitted'], list_local_files: ['path', 'includeHidden', 'offset'], pull_local_files: ['paths', 'destination'] };
    if (!request || !Object.hasOwn(fields, request.name) || typeof request.summary !== 'string' || !request.summary.trim() || request.summary.length > 2000 ||
        Object.keys(request).some(key => !['name', 'summary', ...fields[request.name]!].includes(key)) || request.head !== undefined && !validOid(request.head) || request.includeUncommitted !== undefined && typeof request.includeUncommitted !== 'boolean') throw new Error('Invalid publication request.');
    preparing = true;
    const id = randomUUID(), expiresAt = Date.now() + PUBLISH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acquired = false;
    try {
      const lease = await db.execute({ sql: 'INSERT INTO juiced_publication_leases(project, id, expires) VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET id = excluded.id, expires = excluded.expires WHERE juiced_publication_leases.expires < ? RETURNING id', args: [options.directoryName, id, expiresAt, Date.now()] });
      if (!lease.rows.length) throw new Error('Another session is publishing this project. Wait for it to finish.');
      acquired = true;
      let publication: LocalTransfer;
      if (request.name === 'list_local_files' || request.name === 'pull_local_files') {
        const binding = await readBinding(paths.metadata);
        if (binding?.binding !== options.binding) throw new Error('The workspace binding changed.');
        const files = { id, kind: 'files', summary: request.summary, expiresAt,
          ...(request.name === 'list_local_files' ? { action: 'list', path: request.path, includeHidden: request.includeHidden, offset: request.offset }
            : { action: 'pull', paths: request.paths, destination: request.destination }) } as LocalFilesRequest;
        validateLocalFilesRequest(files);
        publication = files;
      } else if (request.name === 'pull_local_changes') {
        const binding = await readBinding(paths.metadata);
        if (!binding || binding.binding !== options.binding) throw new Error('The workspace binding changed.');
        const upload: UploadRequest = { id, kind: 'upload', summary: request.summary, expiresAt,
          head: await gitText(paths.target, ['rev-parse', 'HEAD']), sourceBranch: binding.sourceBranch,
          includeUncommitted: request.includeUncommitted ?? true, uploadParts: true };
        publication = upload;
      } else {
        const kind = request.name === 'publish_commits' ? 'commits' : 'snapshot';
        const head = request.head ?? await gitText(paths.target, ['rev-parse', 'HEAD']);
        const exported = await runtime.handle({ type: 'git', directoryName: options.directoryName, binding: options.binding, action: 'export', id, known: options.known, head, ...(kind === 'snapshot' ? { snapshot: true } : {}) });
        const manifest = exported.manifest!;
        const before = manifest.snapshot?.baseTree ?? options.known;
        const after = manifest.snapshot?.tree ?? head;
        const changed = (await git(paths.target, ['diff', '--name-only', '--no-renames', '-z', before, after, '--'], { signal: context.signal })).toString().split('\0').filter(Boolean);
        if (kind === 'snapshot' && (changed.length > 4096 || Buffer.byteLength(changed.join('\0')) > 128 * 1024)) throw new Error('This snapshot has too many changed paths. Publish a smaller change.');
        publication = { id, kind, summary: request.summary, manifest, expiresAt, fileCount: changed.length, paths: changed.slice(0, 20).map(path => path.slice(0, 200)) };
      }
      if (closed || connection.destroyed || Date.now() >= expiresAt) throw new Error('The publication expired before it could be offered locally.');
      return await new Promise<PublishResult>((resolve, reject) => {
        const controller = new AbortController();
        const cancel = () => finish({ status: 'failed', message: 'Transfer cancelled or disconnected. Check the destination checkout before retrying.' });
        const finish = (result: PublishResult) => { controller.abort(); connection.off('close', cancel); resolve(result); };
        pending.set(id, { publication, controller, resolve: finish,
          ...(publication.kind === 'files' && publication.action === 'pull' ? { receiver: new LocalFileReceiver(context, options, publication, AbortSignal.any([signal, controller.signal])) } : {}) });
        connection.once('close', cancel);
        timer = setTimeout(() => finish({ status: 'failed', message: 'No local application was confirmed before the publication deadline. Reconnect Juiced and check the local checkout before retrying.' }), Math.max(1, expiresAt - Date.now()));
        void options.send(publication.kind === 'files' ? { type: 'local-files', request: publication } : publication.kind === 'upload' ? { type: 'local-upload', request: publication } : { type: 'local-publish', publication }).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      const item = pending.get(id);
      item?.controller.abort();
      try {
        await item?.completion?.work.catch(() => {});
        await item?.receiver?.close();
      } finally {
        pending.delete(id); preparing = false;
        try { if (acquired) await release(id); }
        finally {
          // Git artifacts and imported refs are retained for review; selective
          // file staging is private and removed when its request finishes.
          await options.send({ type: 'local-publish-done', id }).catch(() => {});
        }
      }
    }
  }

  const server = createServer(connection => {
    sockets.add(connection); connection.on('close', () => sockets.delete(connection));
    connection.setEncoding('utf8'); connection.setTimeout(PUBLISH_TIMEOUT_MS + 10_000, () => connection.destroy());
    let input = '', accepted = false;
    connection.on('error', () => {});
    connection.on('data', data => {
      if (accepted) return;
      input += data;
      if (Buffer.byteLength(input) > 16000) { connection.destroy(); return; }
      if (!input.includes('\n')) return;
      accepted = true;
      const task = (async () => {
        let result: PublishResult;
        try { result = await publish(JSON.parse(input), connection); }
        catch (error) { result = { status: 'failed', message: error instanceof Error ? error.message : 'Publication failed.' }; }
        if (!connection.destroyed) connection.end(JSON.stringify(result) + '\n');
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }

  return {
    configuration: publishMcpConfiguration(socketPath),
    async input(command: PublishCommand): Promise<PublishResult | undefined> {
      if (!validTransferId(command.id)) throw new Error('Invalid publication identity.');
      if (command.type === 'publish-result') {
        const previous = finished.get(command.id);
        if (previous) {
          if (previous.owner !== command.client || previous.fingerprint !== JSON.stringify(command.result)) throw new Error('Conflicting publication result retry.');
          return previous.result;
        }
      }
      const item = pending.get(command.id);
      if (!item || Date.now() >= item.publication.expiresAt || closed) throw new Error('This publication is no longer pending. Check the local checkout before retrying.');
      if (command.type === 'publish-status') return;
      if (!validTransferId(command.client)) throw new Error('Invalid publication client.');
      if (item.owner && item.owner !== command.client) throw new Error('Another local client has claimed this publication.');
      if (command.type === 'publish-claim') { item.owner = command.client; return; }
      if (item.owner !== command.client) throw new Error('Claim the publication before returning its result.');
      if (command.type === 'publish-files') {
        if (!item.receiver || item.completion) throw new Error('This request cannot receive local file chunks.');
        await item.receiver.input(command);
        return;
      }
      validatePublishResult(command.result);
      if (command.result.uploadId !== undefined && item.publication.kind !== 'upload') throw new Error('Unexpected local upload result.');
      if (command.result.listing !== undefined && (item.publication.kind !== 'files' || item.publication.action !== 'list')) throw new Error('Unexpected local listing result.');
      const fingerprint = JSON.stringify(command.result);
      if (item.completion && item.completion.fingerprint !== fingerprint) throw new Error('Conflicting publication result retry.');
      item.completion ??= { fingerprint, work: (async () => {
        let result = command.result;
        if (item.publication.kind === 'files' && publishSucceeded(result)) {
          try {
            if (item.publication.action === 'pull') result = await item.receiver!.apply();
            else {
              const listing = result.listing;
              const request = item.publication;
              if (!listing || listing.path !== request.path || listing.entries.some(entry => {
                const child = request.path === '.' ? entry.path : entry.path.startsWith(request.path + '/') ? entry.path.slice(request.path.length + 1) : '';
                return !child || child.includes('/') || !request.includeHidden && child.startsWith('.');
              })) throw new Error('The local client returned an invalid listing for this request.');
            }
          } catch (error) { result = { status: 'conflict', message: error instanceof Error ? error.message : 'Local file application failed. Inspect the workspace before retrying.' }; }
        } else if (item.publication.kind === 'upload' && publishSucceeded(result)) {
          try {
            if (!result.uploadId) throw new Error('The local client did not prepare an upload. Rebuild the CLI.');
            result = await applyLocalUpload(context, options, item.publication, result.uploadId, AbortSignal.any([signal, item.controller.signal, AbortSignal.timeout(Math.max(1, item.publication.expiresAt - Date.now()))]));
          } catch (error) { result = { status: 'conflict', message: error instanceof Error ? error.message : 'Remote application failed. Inspect the workspace before retrying.' }; }
        } else if ((item.publication.kind === 'commits' || item.publication.kind === 'snapshot') && publishSucceeded(command.result)) {
          // Fence the short acknowledgment transaction against another session
          // acquiring an expired project lease while metadata is being written.
          const now = Date.now();
          const lease = await db.execute({ sql: 'UPDATE juiced_publication_leases SET expires = ? WHERE project = ? AND id = ? AND expires > ? RETURNING id', args: [now + 60_000, options.directoryName, command.id, now] });
          if (!lease.rows.length) throw new Error('Publication ownership expired. Check the local checkout.');
          const binding = await readBinding(paths.metadata);
          if (!binding || binding.binding !== options.binding) throw new Error('The workspace binding changed.');
          const { manifest } = item.publication;
          const publishBase = manifest.snapshot ? { head: manifest.snapshot.baseHead, tree: manifest.snapshot.tree } : { head: manifest.head, tree: await gitText(paths.target, ['rev-parse', `${manifest.head}^{tree}`]) };
          await git(paths.target, ['update-ref', `refs/juiced/baselines/${publishBase.tree}`, publishBase.tree], { signal });
          await atomicJSON(join(paths.metadata, 'binding.json'), { ...binding, publishBase });
        }
        finished.set(command.id, { owner: command.client, fingerprint, result });
        if (finished.size > 128) finished.delete(finished.keys().next().value!);
        item.resolve(result);
        return result;
      })() };
      try { return await item.completion.work; }
      catch (error) { delete item.completion; throw error; }
    },
    async close() {
      closed = true;
      controller.abort();
      for (const item of pending.values()) item.resolve({ status: 'failed', message: 'The remote Claude process stopped. Check the local checkout before retrying.' });
      for (const connection of sockets) connection.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled(tasks);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
