import type { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkspaceRef, WorkspaceSync, WorkspaceSyncStatus } from '@cantelop/sdk';
import { discoverRepository } from './git.js';
import type { selectProject } from './project.js';

function syncError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const messages: Record<string, string> = {
    sync_writes_not_enabled: 'Hosted file uploads are disabled on Cantelop. Enable workspace writes before syncing files.',
    sync_invalid_state: 'This local directory is paired with another workspace or remote folder. Use its previous pairing or a fresh local directory.',
    sync_conflict: 'Local and remote files conflict. Both copies were preserved; resolve the conflicting paths before syncing again.',
    sync_locked: 'Another sync process owns this local directory. Stop it before starting another file sync.',
    sync_helper_unavailable: 'The Cantelop SDK sync adapter is missing or could not start. Reinstall Juiced and its SDK dependency.',
    sync_unavailable: 'Cantelop file sync is unavailable. Check your connection and retry.',
    sync_offline_timeout: 'File sync has been offline for more than 30 seconds. Check your connection and restart the command.',
    sync_stopped: 'The file sync adapter stopped unexpectedly. Restart the command.',
  };
  if (code && messages[code]) return Object.assign(new Error(messages[code]), { code });
  return error instanceof Error ? error : new Error(`File synchronization failed${code ? `: ${code}` : ''}`);
}

function checkStatus(status: WorkspaceSyncStatus) {
  if (status.state === 'conflict') throw syncError({ code: 'sync_conflict' });
  if (status.state === 'error') throw syncError({ code: status.error });
  if (status.state === 'stopped') throw syncError({ code: 'sync_stopped' });
  if (status.writable === false) throw syncError({ code: 'sync_writes_not_enabled' });
}

/** File sync is owned by this explicit command, never by a Claude session. */
export async function syncFiles(workspace: Pick<WorkspaceRef<unknown>, 'sync'>, project: Awaited<ReturnType<typeof selectProject>>, watch: boolean, signal: AbortSignal, stderr: Writable = process.stderr) {
  signal.throwIfAborted();
  if (await discoverRepository(project.localDirectory)) throw new Error('File sync is for non-Git directories. Use juiced claude sync --to-workspace or --from-workspace for a Git repository.');
  signal.throwIfAborted();
  let sync: WorkspaceSync | undefined;
  try {
    stderr.write(`Syncing files in both directions with ${project.workspace}:${project.remoteDirectory}…\n`);
    sync = await workspace.sync({ localDirectory: project.localDirectory, remoteDirectory: project.directoryName, ignore: ['dist', 'coverage'], signal });
    await sync.ready();
    signal.throwIfAborted();
    checkStatus(sync.status());
    if (!watch) { stderr.write(`Files synchronized with ${project.workspace}.\n`); return; }
    stderr.write(`Watching for local and remote file changes. Press Ctrl+C to stop.\n`);
    let offlineAt: number | undefined;
    for (;;) {
      signal.throwIfAborted();
      const status = sync.status();
      checkStatus(status);
      if (status.state === 'offline') {
        if (offlineAt === undefined) stderr.write('File sync is offline; retrying…\n');
        offlineAt ??= Date.now();
      } else if (status.state === 'synced') {
        if (offlineAt !== undefined) stderr.write('File sync reconnected.\n');
        offlineAt = undefined;
      }
      if (offlineAt !== undefined && Date.now() - offlineAt > 30_000) throw syncError({ code: 'sync_offline_timeout' });
      await delay(1000, undefined, { signal });
    }
  } catch (error) { throw syncError(error); }
  finally { await sync?.stop(); }
}
