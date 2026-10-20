import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FileInfo, TransferFile, UploadManifest } from './git-protocol.js';

export class GitError extends Error { constructor(message: string, readonly code: number) { super(message); } }

/** Git owns refs/index locking. No shell, optional index refresh, hooks, or prompts. */
export async function git(directory: string, args: string[], options: { input?: Buffer | string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = []; let bytes = 0; let diagnostic = ''; let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      escalation ??= setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 2000);
      escalation.unref();
    };
    const abort = () => { failure = new Error('Git operation interrupted', { cause: options.signal?.reason }); kill(); };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) { failure = new Error('Git output exceeds the 64 MiB snapshot limit'); kill(); }
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8000); });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('close', code => {
      options.signal?.removeEventListener('abort', abort);
      if (escalation) clearTimeout(escalation);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitError(diagnostic.trim() || `Git exited with code ${code}`, code ?? 1));
      else resolveResult(Buffer.concat(output));
    });
    child.stdin.end(options.input);
  });
}

export const gitText = async (directory: string, args: string[], options: Parameters<typeof git>[2] = {}) => (await git(directory, args, options)).toString().trim();
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export async function fileInfo(path: string, name: TransferFile): Promise<FileInfo> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { name, size: (await stat(path)).size, sha256: hash.digest('hex') };
}

export type Repository = { root: string; relativeDirectory: string; head: string; branch: string | null; binding: string; objectFormat: 'sha1' | 'sha256'; author: { name: string; email: string } };
export async function discoverRepository(directory: string): Promise<Repository | undefined> {
  let root: string;
  try { root = await realpath(await gitText(directory, ['rev-parse', '--show-toplevel'])); }
  catch (error) {
    if (error instanceof GitError && /not a git repository|must be run in a work tree/i.test(error.message)) return;
    throw error;
  }
  // With --quiet, only an unresolvable (unborn) HEAD exits 1; other failures must not read as "no commits".
  const head = await gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(error => {
    if (error instanceof GitError && error.code === 1) throw new Error('This Git repository has no commits. Create an initial commit before using a Git workspace.');
    throw error;
  });
  if (await gitText(root, ['rev-parse', '--is-shallow-repository']) === 'true') throw new Error('Git workspaces require a complete repository. Unshallow this clone first.');
  const branch = await gitText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  const objectFormat = await gitText(root, ['rev-parse', '--show-object-format']) as Repository['objectFormat'];
  const roots = (await gitText(root, ['rev-list', '--max-parents=0', head])).split('\n').sort().join('\n');
  const local = await realpath(directory);
  const relativeDirectory = relative(root, local).split('\\').join('/');
  const author = {
    name: await gitText(root, ['config', 'user.name']).catch(() => 'Juiced'),
    email: await gitText(root, ['config', 'user.email']).catch(() => 'juiced@localhost'),
  };
  return { root, relativeDirectory, head, branch, objectFormat, author, binding: sha256(`${local}\0${root}\0${objectFormat}\0${roots}`) };
}

export async function cleanRepository(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length === 0;
}

export async function ancestor(root: string, before: string, after: string): Promise<boolean> {
  try { await git(root, ['merge-base', '--is-ancestor', before, after]); return true; }
  catch (error) { if (error instanceof GitError && error.code === 1) return false; throw error; }
}

export async function createUpload(repository: Repository, includeUncommitted: boolean, base?: string, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'juiced-git-'));
  const id = randomUUID(); const ref = `refs/juiced/transfers/${id}`;
  const run = (args: string[], options: Parameters<typeof git>[2] = {}) => git(repository.root, args, { ...options, ...(signal ? { signal } : {}) });
  try {
    if ((await run(['ls-files', '--unmerged'])).length) throw new Error('Resolve the local merge conflicts before transferring this repository.');
    if ((await run(['ls-files', '--stage'])).toString().split('\n').some(line => line.startsWith('160000 '))) throw new Error('Submodule contents are not supported by Git workspace transfer yet.');
    await run(['update-ref', ref, repository.head]);
    let exclusions: string[] = [];
    if (base && base !== repository.head) {
      try { await run(['cat-file', '-e', `${base}^{commit}`]); exclusions = [`^${base}`]; } catch {}
    }
    await run(['bundle', 'create', join(directory, 'bundle'), ref, ...exclusions]);
    const files = [await fileInfo(join(directory, 'bundle'), 'bundle')];
    if (includeUncommitted) {
      const indexPath = resolve(repository.root, await gitText(repository.root, ['rev-parse', '--git-path', 'index']));
      const indexDirectory = await mkdtemp(join(dirname(indexPath), 'juiced-index-'));
      try {
        const indexCopy = join(indexDirectory, 'index');
        const originalIndex = await readFile(indexPath);
        await copyFile(indexPath, indexCopy);
        const env = { GIT_INDEX_FILE: indexCopy };
        const diff = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'];
        const staged = await run([...diff, '--cached', repository.head], { env });
        const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z']);
        if (untracked.length) await run(['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: untracked });
        const unstaged = await run(diff, { env });
        if (!unstaged.equals(await run(diff, { env })) || !untracked.equals(await run(['ls-files', '--others', '--exclude-standard', '-z'])) || !originalIndex.equals(await readFile(indexPath))) {
          throw new Error('Local files or the index changed during snapshot capture. Retry the transfer.');
        }
        for (const [name, data] of [['staged', staged], ['unstaged', unstaged]] as const) {
          if (data.length) { await writeFile(join(directory, name), data); files.push(await fileInfo(join(directory, name), name)); }
        }
      } finally { await rm(indexDirectory, { recursive: true, force: true }); }
    }
    if (await gitText(repository.root, ['rev-parse', 'HEAD']) !== repository.head) throw new Error('Local HEAD changed during transfer preparation. Retry.');
    const manifest: UploadManifest = { version: 1, head: repository.head, branch: repository.branch, author: repository.author, objectFormat: repository.objectFormat, files };
    return { id, directory, manifest, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally { await git(repository.root, ['update-ref', '-d', ref]).catch(() => {}); }
}

export function relativeProjectPath(path: string): boolean {
  return typeof path === 'string' && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part !== '..' && part !== '.' && part !== '.git' && (part.length > 0 || path === ''));
}
