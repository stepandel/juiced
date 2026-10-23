import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionHarnessContext } from '@cantelop/sdk/session';
import { cleanRepository, git, gitText } from '../git.js';
import { validTransferId } from '../git-protocol.js';
import type { PublishResult, UploadRequest } from '../publish-protocol.js';
import { atomicJSON, isENOENT } from '../fs-util.js';
import { workingTree } from '../working-tree.js';
import { projectPaths, readBinding } from './git.js';
import { prepareUploadCandidate, readUploadManifest, verifyUploadFiles } from './git-upload.js';
import { acquireCheckout } from './project-state.js';

/** The requesting Claude is waiting in MCP; other sessions must be absent. */
export async function applyLocalUpload(context: SessionHarnessContext, options: { workspace: string; directoryName: string; binding: string; relativeDirectory?: string }, request: UploadRequest, id: string, signal: AbortSignal): Promise<PublishResult> {
  if (!validTransferId(id)) throw new Error('Invalid local upload identity.');
  const paths = await projectPaths(options.workspace, options.directoryName);
  const transfer = join(paths.transfers, id);
  if (!(await lstat(transfer)).isDirectory() || (await lstat(transfer)).isSymbolicLink()) throw new Error('Unsafe upload directory.');
  const controller = new AbortController();
  signal = AbortSignal.any([signal, controller.signal]);
  const lease = await acquireCheckout(await context.database(), options.directoryName, context.session.id, 'maintenance', error => controller.abort(error), true);
  try {
    const binding = await readBinding(paths.metadata);
    if (!binding || binding.binding !== options.binding) throw new Error('The remote repository binding changed.');
    const gitDirectory = await lstat(join(paths.target, '.git'));
    if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) throw new Error('Unsafe remote Git directory.');
    const resultPath = join(transfer, 'live-result.json');
    try {
      const receipt = JSON.parse(await readFile(resultPath, 'utf8')) as { requestId: string; result: PublishResult };
      if (receipt.requestId !== request.id) throw new Error('This upload was already used by another request.');
      return receipt.result;
    }
    catch (error) { if (!isENOENT(error)) throw error; }
    // A crash during Git's multi-step update needs inspection, never a blind retry.
    try { await readFile(join(transfer, 'live-started.json')); throw new Error(`An earlier upload was interrupted. Inspect ${transfer} and the remote checkout before retrying.`); }
    catch (error) { if (!isENOENT(error)) throw error; }
    const manifest = await readUploadManifest(transfer);
    if (manifest.branch !== binding.sourceBranch || manifest.branch !== request.sourceBranch) throw new Error('The local source branch changed.');
    if (!request.includeUncommitted && manifest.files.some(file => file.name !== 'bundle')) throw new Error('This request approved commits only.');
    await verifyUploadFiles(transfer, manifest, 'Incomplete or corrupt local upload.');
    const branch = () => gitText(paths.target, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'HEAD');
    const originalBranch = await branch();
    const check = async () => {
      signal.throwIfAborted();
      if (Date.now() >= request.expiresAt) throw new Error('The local upload expired.');
      if (await gitText(paths.target, ['rev-parse', 'HEAD']) !== request.head || await branch() !== originalBranch) throw new Error('Remote HEAD or branch changed while the upload was pending. Retry.');
      if (!await cleanRepository(paths.target)) throw new Error('The remote checkout has uncommitted changes. Commit or reconcile them before pulling local changes.');
      // Reject sparse checkouts, submodules and embedded repositories as in publication.
      await workingTree(paths.target, signal);
    };
    await check();
    const { candidate, tree, indexTree } = await prepareUploadCandidate(paths.target, transfer, id, manifest, true, signal);
    if (options.relativeDirectory) {
      const directory = await lstat(join(candidate, options.relativeDirectory)).catch(error => { if (isENOENT(error)) return undefined; throw error; });
      if (!directory?.isDirectory() || directory.isSymbolicLink()) throw new Error('This upload removes or replaces Claude’s working directory. Reopen the session from the repository root.');
    }
    const prefix = `refs/juiced/uploads/${id}`;
    await git(candidate, ['update-ref', `${prefix}/index`, indexTree], { signal });
    await git(paths.target, ['fetch', '--atomic', '--no-tags', candidate, `HEAD:${prefix}/head`, `refs/juiced/baselines/${tree}:${prefix}/tree`, `${prefix}/index:${prefix}/index`], { signal });
    const patch = await git(paths.target, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', request.head, tree, '--'], { signal });
    const names = await git(paths.target, ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-only', '-z', request.head, tree, '--'], { signal });
    if (names.toString().split('\0').filter(Boolean).length > 4096 || names.length > 128 * 1024) throw new Error('This upload has too many changed paths.');
    await writeFile(join(transfer, 'live.patch'), patch, { mode: 0o600 });
    if (patch.length) await git(paths.target, ['apply', '--check', '--index', '--binary', '-'], { input: patch, signal });
    await check();
    await atomicJSON(join(transfer, 'live-started.json'), { requestId: request.id, before: request.head, branch: originalBranch, head: manifest.head, tree, indexTree });
    // Keep the directory (and Claude's cwd) in place. Git checks all affected
    // paths before applying; ignored file collisions are refused by --index.
    if (patch.length) await git(paths.target, ['apply', '--index', '--binary', '--whitespace=nowarn', '-'], { input: patch, signal });
    await git(paths.target, ['read-tree', indexTree], { signal });
    await git(paths.target, ['update-ref', originalBranch, manifest.head, request.head], { signal });
    await git(paths.target, ['update-ref', `refs/juiced/baselines/${tree}`, tree], { signal });
    await atomicJSON(join(paths.metadata, 'binding.json'), { ...binding, publishBase: { head: manifest.head, tree } });
    const result: PublishResult = { status: 'applied', message: `Applied local ${request.includeUncommitted ? 'commits and file edits' : 'commits'} to the remote workspace at ${manifest.head.slice(0, 12)}. The conversation can continue.` };
    await atomicJSON(resultPath, { requestId: request.id, result });
    return result;
  } finally { await lease.release(); }
}
