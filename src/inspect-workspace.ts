import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Writable } from 'node:stream';
import type { WorkspaceRef, WorkspaceSelector } from '@cantelop/sdk';
import { discoverRepository, sha256 } from './git.js';
import { selectProject } from './project.js';
import { captureInspection } from './inspection-snapshot.js';
import { compareInspection, renderInspection, renderRemoteListing } from './inspection-view.js';
import { INSPECTION_CHUNK_BYTES, INSPECTION_TIMEOUT_MS, MAX_INSPECTION_BYTES, InspectionIncomplete, inspectionScope, validateInspectionListing, validateInspectionSnapshot, type InspectionListing, type InspectionSnapshot } from './inspection-protocol.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from './protocol.js';

type Workspace = Pick<WorkspaceRef<TerminalCommand, TerminalEvent, TerminalReply>, 'inspect' | 'session' | 'selector'>;
type InspectionApp = { workspace(selector: WorkspaceSelector): Workspace };
type InspectionOptions = { workspace?: string | undefined; path: string; includeIgnored: boolean } & (
  | { action: 'ls' }
  | { action: 'peek'; changesOnly: boolean }
);

type InspectionWorkspace = Pick<Workspace, 'session' | 'selector'>;
type Inspect = Extract<TerminalCommand, { type: 'inspect' }>;
async function checkoutContext<T>(side: 'Local' | 'Remote', work: Promise<T>): Promise<T> {
  try { return await work; }
  catch (error) {
    if (error instanceof InspectionIncomplete) throw new InspectionIncomplete(`${side} checkout: ${error.message}`);
    throw error;
  }
}
export function remoteSnapshot(workspace: InspectionWorkspace, command: Inspect, signal: AbortSignal): Promise<InspectionSnapshot> {
  return remoteInventory(workspace, command, signal, validateInspectionSnapshot);
}
function remoteListing(workspace: InspectionWorkspace, command: Inspect, signal: AbortSignal): Promise<InspectionListing> {
  return remoteInventory(workspace, { ...command, mode: 'listing' }, signal, validateInspectionListing);
}

async function remoteInventory<T>(workspace: InspectionWorkspace, command: Inspect, signal: AbortSignal, validate: (value: unknown, scope: string) => T, fresh = false): Promise<T> {
  if (!workspace.selector.id) throw new InspectionIncomplete('Inspection requires a canonical workspace ID.');
  // Logical session IDs are App-scoped. Include the Workspace and protocol version.
  const id = `ses_inspect_${fresh ? randomUUID().replaceAll('-', '') : sha256(JSON.stringify([1, workspace.selector.id, command.directoryName, command.binding])).slice(0, 32)}`;
  const session = workspace.session({ id, keepAliveSeconds: fresh ? 0 : 120 });
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(INSPECTION_TIMEOUT_MS)]);
  try {
    combined.throwIfAborted();
    // A durable end boundary avoids replaying old inventories across CLI processes.
    const after = fresh ? undefined : await session.view({ signal: combined }).then(view => view.cursor).catch(error => {
      if (['session_view_not_found', 'session_not_found', 'resource_not_found'].includes(String((error as { code?: string }).code))) return undefined;
      throw error;
    });
    const requested = session.request(command, { signal: combined, timeoutMs: INSPECTION_TIMEOUT_MS }).then(reply => {
      if (!reply?.ok) throw new InspectionIncomplete(reply?.error ?? 'The workspace rejected inspection.');
    }).catch(error => { controller.abort(error); throw error; });
    void requested.catch(() => {});
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const event of session.stream({ signal: combined, ...(after ? { after } : {}) })) {
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
          return validate(value, command.scope);
        }
      }
      throw new InspectionIncomplete('The inspection stream ended without a completed inventory.');
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      throw error;
    }
  } catch (error) {
    // A large/abandoned inventory or concurrent readers can outrun retained replay.
    // Retry once in an isolated session that expires as soon as its work settles.
    if (!fresh && !combined.aborted && ['event_cursor_expired', 'event_stream_reset'].includes(String((error as { code?: string }).code))) {
      controller.abort();
      return remoteInventory(workspace, { ...command, id: randomUUID() }, signal, validate, true);
    }
    throw error;
  } finally { controller.abort(); }
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
    const command: Extract<TerminalCommand, { type: 'inspect' }> = { type: 'inspect', id: randomUUID(), directoryName: project.directoryName, binding: repository.binding, scope, includeIgnored: options.includeIgnored };
    // Piped output stays plain; colour needs a terminal that has not opted out.
    const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    const view = { remoteRoot: posix.join(project.remoteDirectory, scope), workspace: project.workspace, workspaceId: existing.id, includeIgnored: options.includeIgnored, columns: stdout.isTTY ? stdout.columns ?? 80 : undefined, color };
    if (options.action === 'ls') {
      const remote = await checkoutContext('Remote', remoteListing(app.workspace({ id: existing.id }), command, combined));
      stdout.write(renderRemoteListing(remote, view));
      return remote.kind === 'ignored' || remote.kind === 'missing' ? 2 : 0;
    }
    const work = [
      checkoutContext('Local', captureInspection(repository.root, scope, options.includeIgnored, combined)),
      checkoutContext('Remote', remoteSnapshot(app.workspace({ id: existing.id }), command, combined)),
    ];
    // Abort the sibling operation on failure and let both release their resources.
    const settled = await Promise.allSettled(work.map(promise => promise.catch(error => { controller.abort(error); throw error; })));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const [local, remote] = settled.map(result => (result as PromiseFulfilledResult<InspectionSnapshot>).value) as [InspectionSnapshot, InspectionSnapshot];
    const comparison = compareInspection(local, remote);
    stdout.write(renderInspection(comparison, {
      ...view, changesOnly: options.changesOnly, localRoot: repository.root,
    }));
    return comparison.rows.some(row => row.status === 'excluded') || local.kind === 'ignored' || remote.kind === 'ignored' ? 2 : 0;
  } finally { controller.abort(); }
}
