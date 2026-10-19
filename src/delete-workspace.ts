import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type RunCantelop = (args: string[], signal: AbortSignal) => Promise<string>;
type DeleteIO = { stdin: Readable & { isTTY?: boolean }; stderr: Writable & { isTTY?: boolean } };

async function runCantelop(args: string[], signal: AbortSignal): Promise<string> {
  try {
    const result = await execute('cantelop', args, { signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    signal.throwIfAborted();
    const detail = error as Error & { code?: string; stderr?: string };
    if (detail.code === 'ENOENT' || /unknown (?:workspace )?command/.test(detail.stderr ?? '')) {
      throw new Error('Install a Cantelop CLI with workspace list/delete support, then run cantelop login.');
    }
    throw new Error(`Cantelop workspace command failed: ${(detail.stderr?.trim() || detail.message).slice(0, 1500)}`);
  }
}

// Resolve with a read-only list, then delete the confirmed canonical ID. Opening
// a Workspace by slug would provision one when it is absent.
export async function deleteWorkspace(app: string, slug: string, yes: boolean, signal: AbortSignal, io: DeleteIO = process, run: RunCantelop = runCantelop) {
  signal.throwIfAborted();
  if (!yes && (!io.stdin.isTTY || !io.stderr.isTTY)) throw new Error('Workspace deletion requires an interactive terminal. Pass --yes to confirm deletion in scripts.');
  const page: unknown = JSON.parse(await run(['workspace', 'list', '--app', app, '--json'], signal));
  if (!page || typeof page !== 'object' || !('items' in page) || !Array.isArray(page.items)) throw new Error('Cantelop returned an invalid Workspace list.');
  const matches = page.items.filter((item: unknown) => item && typeof item === 'object' && 'slug' in item && item.slug === slug && (!('archived_at' in item) || item.archived_at == null));
  if (matches.length === 0) { io.stderr.write(`Workspace ${slug} does not exist.\n`); return; }
  const workspace = matches[0] as { id?: unknown; app_id?: unknown };
  if (matches.length !== 1 || typeof workspace.id !== 'string' || !/^wsp_[0-9a-f]{32}$/.test(workspace.id) || typeof workspace.app_id !== 'string' || !/^app_[0-9a-f]{32}$/.test(workspace.app_id)) throw new Error('Cantelop returned an invalid Workspace identity.');
  io.stderr.write(`Delete workspace ${slug} (${workspace.id}) in ${app}.\nAll sessions will stop. All remote files, Git commits, Claude login, and database data in this workspace will be deleted, including other project folders sharing this workspace.\nLocal files and imported Git refs will be kept. Import any remote commits you want to keep before deleting.\n`);
  if (!yes) {
    const reader = createInterface({ input: io.stdin, output: io.stderr, terminal: true });
    try {
      if ((await reader.question(`Type ${slug} to delete: `, { signal })).trim() !== slug) { io.stderr.write('Cancelled.\n'); return; }
    } finally { reader.close(); }
  }
  signal.throwIfAborted();
  const result: unknown = JSON.parse(await run(['workspace', 'delete', workspace.id, '--yes', '--json'], signal));
  if (!result || typeof result !== 'object' || !('id' in result) || result.id !== workspace.id || !('status' in result) || result.status !== 'deleting') throw new Error('Deletion may have been accepted, but Cantelop returned an invalid response. Check the workspace in the Cantelop console.');
  io.stderr.write(`Deletion requested for ${slug}. Remote data purge is asynchronous; wait for deletion to finish before recreating this workspace.\n`);
}
