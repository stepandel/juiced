import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Writable } from 'node:stream';
import type { WorkspaceRef, WorkspaceSelector } from '@cantelop/sdk';
import { discoverRepository, sha256 } from './git.js';
import { selectProject } from './project.js';
import { captureInspection } from './inspection-snapshot.js';
import { compareInspection, renderInspection } from './inspection-view.js';
import { INSPECTION_CHUNK_BYTES, INSPECTION_TIMEOUT_MS, MAX_INSPECTION_BYTES, InspectionIncomplete, inspectionScope, validateInspectionSnapshot, type InspectionSnapshot } from './inspection-protocol.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from './protocol.js';

type Workspace = Pick<WorkspaceRef<TerminalCommand, TerminalEvent, TerminalReply>, 'inspect' | 'session'>;
type InspectionApp = { workspace(selector: WorkspaceSelector): Workspace };
export type InspectionOptions = { action: 'ls' | 'peek'; workspace?: string | undefined; path: string; includeIgnored: boolean };

export async function remoteSnapshot(workspace: Pick<Workspace, 'session'>, command: Extract<TerminalCommand, { type: 'inspect' }>, signal: AbortSignal): Promise<InspectionSnapshot> {
  const session = workspace.session({ keepAliveSeconds: 120 });
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(INSPECTION_TIMEOUT_MS)]);
  const requested = session.request(command, { signal: combined, timeoutMs: INSPECTION_TIMEOUT_MS }).then(reply => {
    if (!reply?.ok) throw new InspectionIncomplete(reply?.error ?? 'The workspace rejected inspection.');
  }).catch(error => { controller.abort(error); throw error; });
  void requested.catch(() => {});
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const event of session.stream({ signal: combined })) {
      const data = event.data;
      if (!data || !('id' in data) || data.id !== command.id) continue;
      if (data.type === 'inspection-error') throw new InspectionIncomplete(data.message);
      if (data.type === 'inspection-chunk') {
        if (typeof data.data !== 'string' || data.data.length > Math.ceil(INSPECTION_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)) throw new InspectionIncomplete('Invalid inspection chunk.');
        const bytes = Buffer.from(data.data, 'base64');
        if (!bytes.length || data.offset !== size || size + bytes.length > MAX_INSPECTION_BYTES) throw new InspectionIncomplete('The inspection stream is out of order or too large.');
        chunks.push(bytes); size += bytes.length;
      }
      if (data.type === 'inspection-end') {
        const bytes = Buffer.concat(chunks);
        if (data.size !== size || data.sha256 !== sha256(bytes)) throw new InspectionIncomplete('The inspection stream is incomplete or corrupt.');
        await requested;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw new InspectionIncomplete('The workspace returned an invalid inventory.'); }
        return validateInspectionSnapshot(value, command.scope);
      }
    }
    throw new InspectionIncomplete('The inspection stream ended without a completed inventory.');
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    throw error;
  } finally { controller.abort(); await session.stop().catch(() => {}); }
}

export async function inspectWorkspace(app: InspectionApp, directory: string, options: InspectionOptions, signal: AbortSignal, stdout: Writable & { isTTY?: boolean; columns?: number } = process.stdout): Promise<number> {
  const path = inspectionScope(options.path);
  const project = await selectProject(directory, options.workspace);
  const repository = await discoverRepository(project.localDirectory);
  if (!repository) throw new Error('Workspace inspection requires a local Git repository.');
  const scope = [repository.relativeDirectory, path].filter(Boolean).join('/');
  const existing = await app.workspace({ slug: project.workspace }).inspect({ signal });
  signal.throwIfAborted();
  if (!existing) { stdout.write(`Workspace ${project.workspace} does not exist. No workspace was created.\n`); return 2; }
  if (existing.slug !== project.workspace || !/^wsp_[a-f0-9]{32}$/.test(existing.id)) throw new InspectionIncomplete('Cantelop returned an invalid workspace identity.');
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(INSPECTION_TIMEOUT_MS)]);
  try {
    const work = [
      captureInspection(repository.root, scope, options.includeIgnored, combined),
      remoteSnapshot(app.workspace({ id: existing.id }), { type: 'inspect', id: randomUUID(), directoryName: project.directoryName, binding: repository.binding, scope, includeIgnored: options.includeIgnored }, combined),
    ];
    // Abort the sibling operation on failure and let both release their resources.
    const settled = await Promise.allSettled(work.map(promise => promise.catch(error => { controller.abort(error); throw error; })));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const [local, remote] = settled.map(result => (result as PromiseFulfilledResult<InspectionSnapshot>).value) as [InspectionSnapshot, InspectionSnapshot];
    const comparison = compareInspection(local, remote);
    stdout.write(renderInspection(comparison, {
      action: options.action, localRoot: repository.root, remoteRoot: posix.join(project.remoteDirectory, scope),
      workspace: project.workspace, workspaceId: existing.id, includeIgnored: options.includeIgnored,
      columns: stdout.isTTY ? stdout.columns ?? 80 : undefined,
    }));
    return comparison.rows.some(row => row.status === 'excluded') || local.kind === 'ignored' || remote.kind === 'ignored' ? 2 : 0;
  } finally { controller.abort(); }
}
