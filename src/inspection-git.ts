import { lstat, readFile, realpath } from 'node:fs/promises';
import { isENOENT } from './fs-util.js';
import { git, sparseCheckout } from './git.js';
import { InspectionIncomplete, submoduleContents } from './inspection-protocol.js';

/** Read-only Git plumbing shared by inspection snapshots and listings. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Parse Git's NUL-terminated `-z` output; inspected names must be exact UTF-8. */
export function nulStrings(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new InspectionIncomplete('Git returned a truncated inventory.');
  try { return decoder.decode(bytes.subarray(0, -1)).split('\0'); }
  catch { throw new InspectionIncomplete('A Git filename cannot be represented as UTF-8.'); }
}

/** A repository without commits or staged files has no index file yet. */
export async function indexBytes(path: string): Promise<Buffer> {
  try { return await readFile(path); }
  catch (error) { if (isENOENT(error)) return Buffer.alloc(0); throw error; }
}

/** lstat that reports a vanished path (or one under a replaced directory) as absent. */
export async function lstatOptional(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
}

/** The root's identity, checked again at the end to detect a swapped checkout. */
export async function checkoutRoot(root: string) {
  const info = await lstatOptional(root);
  if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new InspectionIncomplete('The checkout root is unavailable or unsafe.');
  return info;
}

/**
 * Git bound to exactly this checkout: inherited GIT_* overrides are removed and
 * caches/daemons that could write or answer from stale state are disabled.
 */
export async function inspectionGit(root: string, signal: AbortSignal) {
  const base = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false'];
  const clean: NodeJS.ProcessEnv = {
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_LITERAL_PATHSPECS: '1',
  };
  const gitDirectory = decoder.decode(await git(root, [...base, 'rev-parse', '--absolute-git-dir'], { env: clean, signal })).trim();
  const env: NodeJS.ProcessEnv = { ...clean, GIT_DIR: gitDirectory, GIT_WORK_TREE: root };
  const run = (args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}) => git(root, [...base, ...args], { ...options, env: { ...env, ...options.env }, signal });
  const text = async (args: string[]) => decoder.decode(await run(args)).trim();
  if (await text(['rev-parse', '--show-toplevel']) !== root) throw new InspectionIncomplete('Git points outside the selected checkout.');
  if (await sparseCheckout(text)) throw new InspectionIncomplete('Workspace inspection does not support sparse checkouts.');
  return { run, text };
}

/** Gitlink paths from `ls-files --stage -z` lines. */
export const gitlinks = (lines: string[]) => lines.filter(line => line.startsWith('160000 ')).map(line => line.slice(line.indexOf('\t') + 1));
/** Registered submodules; a scope inside one belongs to another repository. */
export function stagedSubmodules(lines: string[], scope: string): string[] {
  const paths = gitlinks(lines);
  for (const path of paths) if (scope.startsWith(path + '/')) submoduleContents(path);
  return paths;
}

/** Keep the caller's own failures; wrap unexpected Git/filesystem errors. Aborts win. */
export function inspectionFailure(error: unknown, signal: AbortSignal, action: 'inspect' | 'list'): never {
  signal.throwIfAborted();
  if (error instanceof InspectionIncomplete) throw error;
  throw new InspectionIncomplete(`Unable to ${action} checkout: ${error instanceof Error ? error.message : 'Git failed'}`);
}

/** Run `work` over items with bounded concurrency; results stay in input order. */
export async function settleAll<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await work(items[index]!) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
