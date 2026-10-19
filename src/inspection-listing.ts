import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { git, GitError, relativeProjectPath } from './git.js';
import { InspectionIncomplete, type InspectionListing, type ListingEntry } from './inspection-protocol.js';

function paths(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new InspectionIncomplete('Git returned a truncated inventory.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)).split('\0'); }
  catch { throw new InspectionIncomplete('A Git filename cannot be represented as UTF-8.'); }
}

async function info(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
}
async function index(path: string) {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }
}
function mode(stat: NonNullable<Awaited<ReturnType<typeof info>>>): ListingEntry['mode'] {
  if (stat.isSymbolicLink()) return '120000';
  if (stat.isDirectory()) return '040000';
  if (stat.isFile()) return stat.mode & 0o100n ? '100755' : '100644';
  throw new InspectionIncomplete('The selected scope contains a special file that Git cannot list.');
}

/** Git chooses paths; lstat chooses types. No content reads, filters or objects. */
export async function captureListing(root: string, scope: string, includeIgnored: boolean, signal: AbortSignal): Promise<InspectionListing> {
  signal.throwIfAborted();
  if (!relativeProjectPath(scope)) throw new InspectionIncomplete('Invalid inspection scope.');
  try {
    const rootBefore = await info(root);
    if (!rootBefore?.isDirectory() || rootBefore.isSymbolicLink() || await realpath(root) !== root) throw new InspectionIncomplete('The checkout root is unavailable or unsafe.');
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
      GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_LITERAL_PATHSPECS: '1',
    };
    const run = (args: string[], input?: Buffer) => git(root, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', ...args], { env, signal, ...(input ? { input } : {}) });
    const text = async (args: string[]) => (await run(args)).toString().trim();
    env.GIT_DIR = await text(['rev-parse', '--absolute-git-dir']); env.GIT_WORK_TREE = root;
    if (await text(['rev-parse', '--show-toplevel']) !== root) throw new InspectionIncomplete('Git points outside the selected checkout.');
    if (await text(['config', '--bool', 'core.sparseCheckout']).catch(() => 'false') === 'true') throw new InspectionIncomplete('Workspace inspection does not support sparse checkouts.');
    const directories = new Map<string, boolean>([['', true]]);
    const ancestors = async (path: string, strict = false) => {
      let current = '';
      for (const part of path.split('/').slice(0, -1)) {
        current = current ? current + '/' + part : part;
        if (!directories.has(current)) {
          const stat = await info(join(root, current));
          if (strict && stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new InspectionIncomplete('The selected path has a non-directory or symlink ancestor.');
          directories.set(current, !!stat?.isDirectory() && !stat.isSymbolicLink());
        }
        if (!directories.get(current)) return false;
      }
      return true;
    };
    await ancestors(scope, true);
    const indexPath = await text(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const originalIndex = await index(indexPath);
    const selectedPaths = ['--', scope || '.'];
    const inventory = () => run(['ls-files', '--cached', '--others', '--exclude-standard', '-z', ...selectedPaths]);
    const ignored = () => includeIgnored ? run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...selectedPaths]) : Promise.resolve(Buffer.alloc(0));
    const before = await inventory(), ignoredBefore = await ignored();
    const staged = paths(await run(['ls-files', '--stage', '-z', ...selectedPaths]));
    if (staged.some(line => line.startsWith('160000 '))) throw new InspectionIncomplete('Submodule contents cannot be inspected. Select a different path.');
    const selected = await info(join(root, scope));
    const tracked = staged.length > 0;
    let selectedIgnored = false;
    if (scope && selected && !tracked && !includeIgnored) {
      // check-ignore interprets stdin paths literally, independently of pathspecs.
      try { selectedIgnored = (await git(root, ['check-ignore', '-z', '--stdin'], { env: { ...env, GIT_LITERAL_PATHSPECS: undefined }, signal, input: Buffer.from(scope + '\0') })).length > 0; }
      catch (error) { if (!(error instanceof GitError && error.code === 1)) throw error; }
    }
    const entries = new Map<string, ListingEntry>();
    let visible = !scope;
    for (const raw of new Set([...paths(before), ...paths(ignoredBefore)])) {
      signal.throwIfAborted();
      const path = raw.replace(/\/$/, '');
      if (scope && path !== scope && !path.startsWith(scope + '/')) continue;
      if (!await ancestors(path)) continue; // Stale tracked descendants beneath a replaced directory.
      const stat = await info(join(root, path));
      if (!stat) continue;
      mode(stat);
      if (stat.isDirectory() && await info(join(root, path, '.git'))) throw new InspectionIncomplete('Submodule contents cannot be inspected. Select a different path.');
      if (stat.isDirectory()) continue; // Git never lists empty directories.
      visible = true;
      if (path === scope) continue;
      const relative = scope ? path.slice(scope.length + 1) : path;
      const name = relative.split('/')[0]!;
      if (!entries.has(name)) {
        const child = await info(join(root, scope, name));
        if (!child) throw new InspectionIncomplete('The checkout changed during inspection. Retry the command.');
        entries.set(name, { name, mode: mode(child) });
      }
    }
    const kind = selectedIgnored ? 'ignored' : !selected || !visible ? 'missing' : selected.isDirectory() ? 'directory' : 'file';
    const rootAfter = await info(root);
    if (rootAfter?.dev !== rootBefore.dev || rootAfter?.ino !== rootBefore.ino || !originalIndex.equals(await index(indexPath)) ||
        !before.equals(await inventory()) || !ignoredBefore.equals(await ignored())) throw new InspectionIncomplete('The checkout changed during inspection. Retry the command.');
    return { version: 1, scope, kind, entries: kind === 'directory' ? [...entries.values()] : [],
      ...(['directory', 'file'].includes(kind) ? { entry: { name: posix.basename(scope) || '(root)', mode: mode(selected!) } } : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof InspectionIncomplete) throw error;
    throw new InspectionIncomplete(`Unable to list checkout: ${error instanceof Error ? error.message : 'Git failed'}`);
  }
}
