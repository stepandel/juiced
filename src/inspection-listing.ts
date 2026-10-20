import { join, posix } from 'node:path';
import { GitError, relativeProjectPath } from './git.js';
import { checkoutRoot, indexBytes as index, inspectionFailure, inspectionGit, lstatOptional as info, nulStrings as paths, settleAll, stagedSubmodules } from './inspection-git.js';
import { InspectionIncomplete, submoduleContents, type InspectionListing, type ListingEntry } from './inspection-protocol.js';

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
    const rootBefore = await checkoutRoot(root);
    const { run, text } = await inspectionGit(root, signal);
    const directories = new Map<string, boolean>([['', true]]);
    const ancestors = async (path: string, strict = false) => {
      let current = '';
      for (const part of path.split('/').slice(0, -1)) {
        current = current ? current + '/' + part : part;
        if (!directories.has(current)) {
          const stat = await info(join(root, current));
          if (strict && stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new InspectionIncomplete('The selected path has a non-directory or symlink ancestor.');
          if (strict && stat?.isDirectory() && await info(join(root, current, '.git'))) submoduleContents(current);
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
    const staged = paths(await run(['ls-files', '--stage', '-z']));
    const submodules = new Set(stagedSubmodules(staged, scope));
    const selected = await info(join(root, scope));
    const tracked = staged.some(line => { const path = line.slice(line.indexOf('\t') + 1); return !scope || path === scope || path.startsWith(scope + '/'); });
    let selectedIgnored = false;
    if (scope && selected && !tracked && !includeIgnored) {
      // check-ignore interprets stdin paths literally, independently of pathspecs.
      try { selectedIgnored = (await run(['check-ignore', '-z', '--stdin'], { env: { GIT_LITERAL_PATHSPECS: undefined }, input: Buffer.from(scope + '\0') })).length > 0; }
      catch (error) { if (!(error instanceof GitError && error.code === 1)) throw error; }
    }
    const entries = new Map<string, ListingEntry>();
    let visible = !scope;
    const candidates = [...new Set([...paths(before), ...paths(ignoredBefore)])].map(raw => raw.replace(/\/$/, ''))
      .filter(path => !scope || path === scope || path.startsWith(scope + '/'));
    // Stat large inventories concurrently; results are consumed (and errors raised) in inventory order.
    const stats = await settleAll(candidates, 64, path => { signal.throwIfAborted(); return info(join(root, path)); });
    for (const [i, path] of candidates.entries()) {
      signal.throwIfAborted();
      if (!await ancestors(path)) continue; // Stale tracked descendants beneath a replaced directory.
      const result = stats[i]!;
      if (result.status === 'rejected') throw result.reason;
      const stat = result.value;
      if (!stat) continue;
      mode(stat);
      const submodule = stat.isDirectory() && (submodules.has(path) || !!await info(join(root, path, '.git')));
      if (stat.isDirectory() && !submodule) continue; // Git never lists empty directories.
      visible = true;
      if (path === scope) continue;
      const relative = scope ? path.slice(scope.length + 1) : path;
      const name = relative.split('/')[0]!;
      if (!entries.has(name)) {
        const child = await info(join(root, scope, name));
        if (!child) throw new InspectionIncomplete('The checkout changed during inspection. Retry the command.');
        entries.set(name, { name, mode: submodule && relative === name ? '160000' : mode(child) });
      }
    }
    const selectedSubmodule = selected?.isDirectory() && (submodules.has(scope) || !!scope && !!await info(join(root, scope, '.git')));
    const kind = selectedIgnored ? 'ignored' : selectedSubmodule ? 'file' : !selected || !visible ? 'missing' : selected.isDirectory() ? 'directory' : 'file';
    const rootAfter = await info(root);
    if (rootAfter?.dev !== rootBefore.dev || rootAfter?.ino !== rootBefore.ino || !originalIndex.equals(await index(indexPath)) ||
        !before.equals(await inventory()) || !ignoredBefore.equals(await ignored())) throw new InspectionIncomplete('The checkout changed during inspection. Retry the command.');
    return { version: 1, scope, kind, entries: kind === 'directory' ? [...entries.values()] : [],
      ...(['directory', 'file'].includes(kind) ? { entry: { name: posix.basename(scope) || '(root)', mode: selectedSubmodule ? '160000' as const : mode(selected!) } } : {}),
    };
  } catch (error) { inspectionFailure(error, signal, 'list'); }
}
