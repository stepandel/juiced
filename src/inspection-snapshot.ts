import { mkdtemp, mkdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isENOENT } from './fs-util.js';
import { GitError, relativeProjectPath } from './git.js';
import { checkoutRoot, gitlinks, indexBytes, inspectionFailure, inspectionGit, lstatOptional, nulStrings as strings, settleAll, stagedSubmodules } from './inspection-git.js';
import { InspectionIncomplete, submoduleContents, type InspectionSnapshot, type TreeEntry } from './inspection-protocol.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
function parseTree(bytes: Buffer): TreeEntry[] {
  return strings(bytes).map(line => {
    const match = /^(040000|100644|100755|120000|160000) (?:tree|blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(line);
    if (!match) throw new InspectionIncomplete('Unsupported Git entry in the selected scope.');
    return { mode: match[1] as TreeEntry['mode'], oid: match[2]!, name: match[3]! };
  });
}

/** Git writes only to a private index/object directory. No commits or source refs. */
export async function captureInspection(root: string, scope: string, includeIgnored: boolean, signal: AbortSignal): Promise<InspectionSnapshot> {
  signal.throwIfAborted();
  if (!relativeProjectPath(scope)) throw new InspectionIncomplete('Invalid inspection scope.');
  const startedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), 'juiced-inspect-'));
  try {
    const rootBefore = await checkoutRoot(root);
    // Concurrent reads stop their siblings once one fails.
    const reads = new AbortController();
    const stopReads = (error: unknown): never => { reads.abort(error); throw error; };
    const { run, text } = await inspectionGit(root, AbortSignal.any([signal, reads.signal]));
    // A path argument never follows an ancestor symlink to another directory.
    let ancestor = root;
    for (const part of scope.split('/').slice(0, -1)) {
      ancestor = join(ancestor, part);
      try {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new InspectionIncomplete('The selected path has a non-directory or symlink ancestor.');
        try { await lstat(join(ancestor, '.git')); submoduleContents(posix.relative(root, ancestor)); }
        catch (error) { if (!isENOENT(error)) throw error; }
      } catch (error) { if (!isENOENT(error)) throw error; break; }
    }
    const indexPath = await text(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const readBranch = () => text(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(error => { if (error instanceof GitError && error.code === 1) return null; throw error; });
    const paths = ['--', scope || '.'];
    const inventory = () => run(['ls-files', '--cached', '--others', '--exclude-standard', '-z', ...paths]);
    const ignoredPaths = () => run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', ...paths]);
    const [originalIndex, head, branch, objectFormat, before, ignoredBefore, staged, objectDirectory] = await Promise.all([
      indexBytes(indexPath), text(['rev-parse', '--verify', 'HEAD']), readBranch(),
      text(['rev-parse', '--show-object-format']) as Promise<InspectionSnapshot['objectFormat']>,
      inventory(), ignoredPaths(), run(['ls-files', '--stage', '-z']),
      text(['rev-parse', '--path-format=absolute', '--git-path', 'objects']),
    ]).catch(stopReads);
    const stagedEntries = strings(staged);
    stagedSubmodules(stagedEntries, scope);
    // Git silently skips some special files; report those instead of false absence.
    const eligible = new Set([...strings(before), ...(includeIgnored ? strings(await run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...paths])) : [])]);
    // Large inventories: stat concurrently, then report the first failure in inventory order.
    for (const result of await settleAll([...eligible], 64, async path => {
      signal.throwIfAborted();
      const info = await lstatOptional(join(root, path));
      if (info && !info.isFile() && !info.isSymbolicLink() && !info.isDirectory()) throw new InspectionIncomplete('The selected scope contains a special file that Git cannot compare.');
    })) if (result.status === 'rejected') throw result.reason;
    const objects = join(directory, 'objects'); await mkdir(objects);
    const temporary = {
      GIT_INDEX_FILE: join(directory, 'index'), GIT_OBJECT_DIRECTORY: objects,
      // Git accepts C-quoted alternate paths; quotes protect separators in paths.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objectDirectory),
    };
    // Recreate entries without stat caches or assume-unchanged bits, then ask Git
    // to capture working-tree bytes, including staged additions and deletions.
    await run(['update-index', '-z', '--index-info'], { input: staged, env: temporary });
    // An absent, untracked literal path is valid; git add would reject it.
    let present = !scope;
    if (scope) { try { await lstat(join(root, scope)); present = true; } catch (error) { if (!isENOENT(error)) throw error; } }
    const tracked = stagedEntries.some(line => {
      const path = line.slice(line.indexOf('\t') + 1);
      return !scope || path === scope || path.startsWith(scope + '/');
    });
    const selectedIgnored = scope && present && !tracked && (await run(['check-ignore', '-z', '--stdin'], { input: Buffer.from(scope + '\0'), env: { GIT_LITERAL_PATHSPECS: undefined } }).catch(error => { if (error instanceof GitError && error.code === 1) return Buffer.alloc(0); throw error; })).length > 0;
    if (!selectedIgnored || includeIgnored) {
      if (present || tracked) await run(['add', '-A', ...(includeIgnored ? ['-f'] : []), ...paths], { env: temporary });
    }
    // Git also turns previously untracked embedded repositories into gitlinks.
    const submodules = [...new Set(gitlinks(strings(await run(['ls-files', '--stage', '-z', ...paths], { env: temporary })))
      .filter(path => !scope || path === scope || path.startsWith(scope + '/'))
      .map(path => path === scope ? posix.basename(path) : path.slice(scope ? scope.length + 1 : 0).split('/')[0]!))];
    const tree = decoder.decode(await run(['write-tree'], { env: temporary })).trim();
    const selected = scope ? parseTree(await run(['ls-tree', '-z', tree, '--', scope], { env: temporary }))[0] : { name: '.', mode: '040000' as const, oid: tree };
    const kind = selectedIgnored && !includeIgnored ? 'ignored' : !selected ? 'missing' : selected.mode === '040000' ? 'directory' : 'file';
    const entries = kind === 'directory' ? parseTree(await run(['ls-tree', '-z', selected!.oid], { env: temporary })) : [];
    const prefix = scope ? scope + '/' : '';
    const ignored = [...new Set(strings(ignoredBefore).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]!).filter(Boolean))];
    // Nested repository contents are explicitly excluded from the comparison.
    try { await run(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...paths], { env: temporary }); }
    catch (error) { if (error instanceof GitError && error.code === 1) throw new InspectionIncomplete('Files changed during inspection. Retry the command.'); throw error; }
    const [rootAfter, currentBranch, currentHead, currentIndex, currentInventory, currentIgnored] = await Promise.all([
      lstat(root, { bigint: true }), readBranch(), text(['rev-parse', 'HEAD']), indexBytes(indexPath), inventory(), ignoredPaths(),
    ]).catch(stopReads);
    if (rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino || branch !== currentBranch || head !== currentHead ||
        !originalIndex.equals(currentIndex) || !before.equals(currentInventory) || !ignoredBefore.equals(currentIgnored)) throw new InspectionIncomplete('The checkout changed during inspection. Retry the command.');
    const result: InspectionSnapshot = { version: 1, scope, kind, entries, ignored: includeIgnored ? [] : ignored, head, branch, objectFormat, startedAt, finishedAt: new Date().toISOString() };
    if (submodules.length) result.submodules = submodules;
    if (selected && kind !== 'ignored') result.entry = { ...selected, name: posix.basename(scope) || '(root)' };
    return result;
  } catch (error) { inspectionFailure(error, signal, 'inspect'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
