import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { WorkspaceSync, WorkspaceSyncOptions } from '@cantelop/sdk';

import { validProjectName } from './project-name.js';

export async function selectProject(directory: string, workspace?: string) {
  const localDirectory = await realpath(directory);
  const directoryName = basename(localDirectory);
  if (!validProjectName(directoryName)) throw new Error('This directory name cannot be used as a remote project folder. Use a visible project directory with a portable name.');
  const label = directoryName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 46).replace(/-+$/g, '') || 'project';
  const hash = createHash('sha256').update(localDirectory).digest('hex').slice(0, 16);
  return { localDirectory, directoryName, remoteDirectory: `/workspace/${directoryName}`, workspace: workspace ?? `${label}-${hash}` };
}

type ProjectWorkspace = { sync(options: WorkspaceSyncOptions): Promise<WorkspaceSync> };

export function syncError(error: unknown): Error {
  const code = (error as { code?: string }).code;
  const explanations: Record<string, string> = {
    sync_writes_not_enabled: 'Hosted uploads are disabled on Cantelop pending storage qualification. No Claude agent was started with an unsynced project.',
    sync_invalid_state: 'This local directory was paired with another workspace or remote folder. Use its previous pairing or a fresh local directory.',
    sync_conflict: 'Local and remote files conflict. Both copies were preserved; resolve the conflicting paths before restarting.',
    sync_locked: 'Another sync process owns this local directory. Close that Juiced session before starting another.',
    sync_helper_unavailable: 'The Cantelop SDK sync adapter is missing or could not start. Reinstall Juiced and its SDK dependency.',
    sync_cli_upgrade_required: 'This Cantelop SDK requires an external sync helper. Upgrade Juiced to use the SDK with its bundled adapter.',
    invalid_sync_root: 'The deployed Cantelop platform does not support workspace-relative sync. Deploy the matching platform release first.',
    runtime_method_not_allowed: 'Deploy the matching Cantelop platform and rebuild the App Edge before using project sync.',
  };
  if (code && explanations[code]) return Object.assign(new Error(explanations[code]), { code });
  if (error instanceof TypeError && error.message === 'Invalid sync options') return new Error('The installed Cantelop SDK does not support workspace-relative sync. Install the matching SDK release before running Juiced.');
  return error instanceof Error ? error : new Error('Project synchronization failed');
}

// A single handle owns the directory for the lifetime of this invocation.
export async function synchronizeProject(workspace: ProjectWorkspace, project: Awaited<ReturnType<typeof selectProject>>, signal: AbortSignal) {
  let sync: WorkspaceSync | undefined;
  const flush = async () => { try { await sync!.flush(); } catch (error) { throw syncError(error); } };
  try {
    sync = await workspace.sync({ localDirectory: project.localDirectory, remoteDirectory: project.directoryName,
      ignore: ['dist', 'coverage'], signal });
    await sync.ready();
    const status = sync.status();
    if ('writable' in status && status.writable === false) throw Object.assign(new Error('Hosted uploads are disabled'), { code: 'sync_writes_not_enabled' });
    return {
      flush,
      status: () => sync!.status(),
      async close() {
        try { if (!signal.aborted) await flush(); } finally { await sync!.stop(); }
      },
    };
  } catch (error) { await sync?.stop(); throw syncError(error); }
}
