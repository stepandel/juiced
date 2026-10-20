import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { WorkspaceRef, WorkspaceSelector } from '@cantelop/sdk';
import { validWorkspaceId } from './protocol.js';

type DeletionApp = {
  readonly name: string;
  workspace(selector: WorkspaceSelector): Pick<WorkspaceRef<unknown>, 'inspect' | 'delete'>;
};
type DeleteIO = { stdin: Readable & { isTTY?: boolean }; stderr: Writable & { isTTY?: boolean } };

// Inspection never provisions a missing workspace. Confirm its canonical ID,
// then delete that ID so a concurrent replacement with the same slug is safe.
export async function deleteWorkspace(app: DeletionApp, slug: string, yes: boolean, signal: AbortSignal, io: DeleteIO = process) {
  signal.throwIfAborted();
  if (!yes && (!io.stdin.isTTY || !io.stderr.isTTY)) throw new Error('Workspace deletion requires an interactive terminal. Pass --yes to confirm deletion in scripts.');
  const existing = await app.workspace({ slug }).inspect({ signal });
  signal.throwIfAborted();
  if (!existing) { io.stderr.write(`Workspace ${slug} does not exist.\n`); return; }
  if (existing.slug !== slug || !validWorkspaceId(existing.id)) throw new Error('Cantelop returned an invalid Workspace identity.');
  io.stderr.write(`Delete workspace ${slug} (${existing.id}) in ${app.name}.\nAll sessions will stop. All remote files, Git commits, Claude login, and database data in this workspace will be deleted, including other project folders sharing this workspace.\nLocal files and imported Git refs will be kept. Import any remote commits you want to keep before deleting.\n`);
  if (!yes) {
    const reader = createInterface({ input: io.stdin, output: io.stderr, terminal: true });
    try {
      if ((await reader.question(`Type ${slug} to delete: `, { signal })).trim() !== slug) { io.stderr.write('Cancelled.\n'); return; }
    } finally { reader.close(); }
  }
  signal.throwIfAborted();
  const result = await app.workspace({ id: existing.id }).delete({ signal });
  if (!result || result.id !== existing.id || result.status !== 'deleting') throw new Error('Deletion may have been accepted, but Cantelop returned an invalid response. Check the workspace in the Cantelop console.');
  io.stderr.write(`Deletion requested for ${slug}. Remote data purge is asynchronous; wait for deletion to finish before recreating this workspace.\n`);
}
