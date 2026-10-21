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
import { atomicJSON, createGitRuntime, projectPaths, readBinding } from './git.js';
import { applyLocalUpload } from './local-upload.js';
import { publishMcpConfiguration } from './publish-mcp.js';

type Pending = { publication: LocalTransfer; controller: AbortController; owner?: string; completion?: { fingerprint: string; work: Promise<PublishResult> }; resolve(result: PublishResult): void };

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

  async function publish(request: { name: string; summary: string; head?: string; includeUncommitted?: boolean }, connection: Socket): Promise<PublishResult> {
    if (closed || preparing || pending.size) throw new Error('Another local publication is still pending.');
    if (!request || !['publish_commits', 'publish_snapshot', 'pull_local_changes'].includes(request.name) || typeof request.summary !== 'string' || !request.summary.trim() || request.summary.length > 2000 ||
        Object.keys(request).some(key => !['name', 'summary', 'head', 'includeUncommitted'].includes(key)) || request.head !== undefined && (request.name !== 'publish_commits' || !validOid(request.head)) || request.includeUncommitted !== undefined && (request.name !== 'pull_local_changes' || typeof request.includeUncommitted !== 'boolean')) throw new Error('Invalid publication request.');
    preparing = true;
    const id = randomUUID(), expiresAt = Date.now() + PUBLISH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acquired = false;
    try {
      const lease = await db.execute({ sql: 'INSERT INTO juiced_publication_leases(project, id, expires) VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET id = excluded.id, expires = excluded.expires WHERE juiced_publication_leases.expires < ? RETURNING id', args: [options.directoryName, id, expiresAt, Date.now()] });
      if (!lease.rows.length) throw new Error('Another session is publishing this project. Wait for it to finish.');
      acquired = true;
      let publication: LocalTransfer;
      if (request.name === 'pull_local_changes') {
        const binding = await readBinding(paths.metadata);
        if (!binding || binding.binding !== options.binding) throw new Error('The workspace binding changed.');
        const upload: UploadRequest = { id, kind: 'upload', summary: request.summary, expiresAt,
          head: await gitText(paths.target, ['rev-parse', 'HEAD']), sourceBranch: binding.sourceBranch,
          includeUncommitted: request.includeUncommitted ?? true };
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
        pending.set(id, { publication, controller, resolve: finish });
        connection.once('close', cancel);
        timer = setTimeout(() => finish({ status: 'failed', message: 'No local application was confirmed before the publication deadline. Reconnect Juiced and check the local checkout before retrying.' }), Math.max(1, expiresAt - Date.now()));
        void options.send(publication.kind === 'upload' ? { type: 'local-upload', request: publication } : { type: 'local-publish', publication }).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      pending.delete(id); preparing = false;
      if (acquired) await release(id);
      // Failed artifacts are retained remotely for diagnosis/review. Local
      // imports retain immutable refs and downloaded patches independently.
      await options.send({ type: 'local-publish-done', id }).catch(() => {});
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
      if (Buffer.byteLength(input) > 8000) { connection.destroy(); return; }
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
      validatePublishResult(command.result);
      if (command.result.uploadId !== undefined && item.publication.kind !== 'upload') throw new Error('Unexpected local upload result.');
      const fingerprint = JSON.stringify(command.result);
      if (item.completion && item.completion.fingerprint !== fingerprint) throw new Error('Conflicting publication result retry.');
      item.completion ??= { fingerprint, work: (async () => {
        let result = command.result;
        if (item.publication.kind === 'upload' && publishSucceeded(result)) {
          try {
            if (!result.uploadId) throw new Error('The local client did not prepare an upload. Rebuild the CLI.');
            result = await applyLocalUpload(context, options, item.publication, result.uploadId, AbortSignal.any([signal, item.controller.signal, AbortSignal.timeout(Math.max(1, item.publication.expiresAt - Date.now()))]));
          } catch (error) { result = { status: 'conflict', message: error instanceof Error ? error.message : 'Remote application failed. Inspect the workspace before retrying.' }; }
        } else if (item.publication.kind !== 'upload' && publishSucceeded(command.result)) {
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
