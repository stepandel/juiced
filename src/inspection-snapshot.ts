import { mkdtemp, mkdir, readFile, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { git, GitError, relativeProjectPath } from './git.js';
import { InspectionIncomplete, submoduleContents, type InspectionSnapshot, type TreeEntry } from './inspection-protocol.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
function strings(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new InspectionIncomplete('Git returned a truncated inventory.');
  try { return decoder.decode(bytes.subarray(0, -1)).split('\0'); }
  catch { throw new InspectionIncomplete('A Git filename cannot be represented as UTF-8.'); }
}
function parseTree(bytes: Buffer): TreeEntry[] {
  return strings(bytes).map(line => {
    const match = /^(040000|100644|100755|120000|160000) (?:tree|blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(line);
    if (!match) throw new InspectionIncomplete('Unsupported Git entry in the selected scope.');
    return { mode: match[1] as TreeEntry['mode'], oid: match[2]!, name: match[3]! };
  });
}
const indexBytes = async (path: string) => {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }
};

/** Git writes only to a private index/object directory. No commits or source refs. */
export async function captureInspection(root: string, scope: string, includeIgnored: boolean, signal: AbortSignal): Promise<InspectionSnapshot> {
  signal.throwIfAborted();
  if (!relativeProjectPath(scope)) throw new InspectionIncomplete('Invalid inspection scope.');
  const startedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), 'juiced-inspect-'));
  try {
    const rootBefore = await lstat(root, { bigint: true });
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || await realpath(root) !== root) throw new InspectionIncomplete('The checkout root is unavailable or unsafe.');
    const clean: NodeJS.ProcessEnv = {
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
      GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_LITERAL_PATHSPECS: '1',
    };
    const base = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false'];
    const initial = (args: string[]) => git(root, [...base, ...args], { env: clean, signal });
    const gitDirectory = decoder.decode(await initial(['rev-parse', '--absolute-git-dir'])).trim();
    const env: NodeJS.ProcessEnv = { ...clean, GIT_DIR: gitDirectory, GIT_WORK_TREE: root };
    const run = (args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}) => git(root, [...base, ...args], { ...options, env: { ...env, ...options.env }, signal });
    const text = async (args: string[]) => decoder.decode(await run(args)).trim();
    if (await text(['rev-parse', '--show-toplevel']) !== root) throw new InspectionIncomplete('Git points outside the selected checkout.');
    if (await text(['config', '--bool', 'core.sparseCheckout']).catch(() => 'false') === 'true') throw new InspectionIncomplete('Workspace inspection does not support sparse checkouts.');
    // A path argument never follows an ancestor symlink to another directory.
    let ancestor = root;
    for (const part of scope.split('/').slice(0, -1)) {
      ancestor = join(ancestor, part);
      try {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new InspectionIncomplete('The selected path has a non-directory or symlink ancestor.');
        try { await lstat(join(ancestor, '.git')); submoduleContents(posix.relative(root, ancestor)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; break; }
    }
    const indexPath = await text(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const originalIndex = await indexBytes(indexPath);
    const head = await text(['rev-parse', '--verify', 'HEAD']);
    const branch = await text(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(error => { if (error instanceof GitError && error.code === 1) return null; throw error; });
    const objectFormat = await text(['rev-parse', '--show-object-format']) as InspectionSnapshot['objectFormat'];
    const paths = ['--', scope || '.'];
    const inventory = () => run(['ls-files', '--cached', '--others', '--exclude-standard', '-z', ...paths]);
    const ignoredPaths = () => run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', ...paths]);
    const before = await inventory(), ignoredBefore = await ignoredPaths();
    const staged = await run(['ls-files', '--stage', '-z']);
    const submodulePaths = (bytes: Buffer) => strings(bytes).filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
    for (const path of submodulePaths(staged)) if (scope.startsWith(path + '/')) submoduleContents(path);
    // Git silently skips some special files; report those instead of false absence.
    const eligible = new Set([...strings(before), ...(includeIgnored ? strings(await run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...paths])) : [])]);
    for (const path of eligible) {
      try {
        const info = await lstat(join(root, path));
        if (!info.isFile() && !info.isSymbolicLink() && !info.isDirectory()) throw new InspectionIncomplete('The selected scope contains a special file that Git cannot compare.');
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const objects = join(directory, 'objects'); await mkdir(objects);
    const temporary = {
      GIT_INDEX_FILE: join(directory, 'index'), GIT_OBJECT_DIRECTORY: objects,
      // Git accepts C-quoted alternate paths; quotes protect separators in paths.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(await text(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])),
    };
    // Recreate entries without stat caches or assume-unchanged bits, then ask Git
    // to capture working-tree bytes, including staged additions and deletions.
    await run(['update-index', '-z', '--index-info'], { input: staged, env: temporary });
    // An absent, untracked literal path is valid; git add would reject it.
    let present = !scope;
    if (scope) { try { await lstat(join(root, scope)); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const tracked = (await run(['ls-files', '--cached', '-z', ...paths])).length > 0;
    const selectedIgnored = scope && present && !tracked && (await run(['check-ignore', '-z', '--stdin'], { input: Buffer.from(scope + '\0'), env: { GIT_LITERAL_PATHSPECS: undefined } }).catch(error => { if (error instanceof GitError && error.code === 1) return Buffer.alloc(0); throw error; })).length > 0;
    if (!selectedIgnored || includeIgnored) {
      if (present || tracked) await run(['add', '-A', ...(includeIgnored ? ['-f'] : []), ...paths], { env: temporary });
    }
    // Git also turns previously untracked embedded repositories into gitlinks.
    const submodules = [...new Set(submodulePaths(await run(['ls-files', '--stage', '-z', ...paths], { env: temporary }))
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
    const rootAfter = await lstat(root, { bigint: true });
    const currentBranch = await text(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(error => { if (error instanceof GitError && error.code === 1) return null; throw error; });
    if (rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino || branch !== currentBranch || head !== await text(['rev-parse', 'HEAD']) ||
        !originalIndex.equals(await indexBytes(indexPath)) || !before.equals(await inventory()) || !ignoredBefore.equals(await ignoredPaths())) throw new InspectionIncomplete('The checkout changed during inspection. Retry the command.');
    const result: InspectionSnapshot = { version: 1, scope, kind, entries, ignored: includeIgnored ? [] : ignored, head, branch, objectFormat, startedAt, finishedAt: new Date().toISOString() };
    if (submodules.length) result.submodules = submodules;
    if (selected && kind !== 'ignored') result.entry = { ...selected, name: posix.basename(scope) || '(root)' };
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof InspectionIncomplete) throw error;
    throw new InspectionIncomplete(`Unable to inspect checkout: ${error instanceof Error ? error.message : 'Git failed'}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
