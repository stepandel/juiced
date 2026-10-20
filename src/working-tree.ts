import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './git.js';

/** Capture Git-visible working files without touching the real index or making a commit. */
export async function workingTree(root: string, signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'juiced-tree-'));
  const worktree = { GIT_WORK_TREE: root };
  const real = (args: string[]) => git(root, args, { env: worktree, signal });
  const text = async (args: string[]) => (await real(args)).toString().trim();
  const index = await text(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const original = await readFile(index);
  const head = await text(['rev-parse', 'HEAD']);
  const env = { ...worktree, GIT_INDEX_FILE: join(directory, 'index') };
  const run = (args: string[], input?: Buffer) => git(root, ['-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', ...args], { env, signal, ...(input ? { input } : {}) });
  try {
    if (await text(['config', '--bool', 'core.sparseCheckout']).catch(() => 'false') === 'true') throw new Error('Publishing does not support sparse checkouts.');
    const staged = await real(['ls-files', '--stage', '-z']);
    if (staged.toString().split('\0').some(line => line.startsWith('160000 '))) throw new Error('Publishing does not support submodules.');
    if ((await real(['ls-files', '--unmerged'])).length) throw new Error('Resolve merge conflicts before publishing.');
    const inventory = () => real(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const before = await inventory();
    for (const path of before.toString().split('\0').filter(Boolean)) {
      try {
        const info = await lstat(join(root, path));
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error('Publishing does not support embedded repositories or special files.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await run(['update-index', '-z', '--index-info'], staged);
    await run(['add', '-A', '--', '.']);
    if ((await run(['ls-files', '--stage'])).toString().split('\n').some(line => line.startsWith('160000 '))) throw new Error('Publishing does not support embedded repositories.');
    const tree = (await run(['write-tree'])).toString().trim();
    // Capture again to detect changes during hashing, including newly added files.
    await run(['add', '-A', '--', '.']);
    if ((await run(['write-tree'])).toString().trim() !== tree || !before.equals(await inventory()) ||
        !original.equals(await readFile(index)) || head !== await text(['rev-parse', 'HEAD'])) throw new Error('Files or the index changed while capturing the snapshot. Retry.');
    return tree;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
