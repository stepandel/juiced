import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionHarnessContext, SessionOutput } from '@cantelop/sdk/session';
import { applyRemoteConfiguration, validateRemoteConfiguration, type GitRemoteConfiguration } from '../git-remotes.js';
import { ancestor, cleanRepository, fileInfo, git, gitText } from '../git.js';
import { DOWNLOAD_CHUNK_BYTES, MAX_TRANSFER_BYTES, UPLOAD_CHUNK_BYTES, validOid, validTransferId, type ExportManifest, type GitCommand, type GitEvent, type GitResult, type UploadManifest } from '../git-protocol.js';
import { validProjectName } from '../project-name.js';
import { acquireCheckout, reapCheckout } from './project-state.js';
import { workingTree } from '../working-tree.js';
import { isENOENT, writeFileAtomic } from '../fs-util.js';

type Binding = { version: 1; binding: string; sourceBranch: string | null; publishBase?: { head: string; tree: string } };
type Journal = { id: string; binding: Binding; hadOriginal: boolean };
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if (isENOENT(error)) return false; throw error; } };

export async function projectPaths(workspace: string, directoryName: string) {
  if (!validProjectName(directoryName)) throw new Error('Invalid project directory');
  const root = await realpath(workspace);
  const metadata = join(root, '.juiced', directoryName);
  // Every managed ancestor must be a real directory, including on a shared mount.
  for (const path of [join(root, '.juiced'), metadata, join(metadata, 'transfers')]) {
    await mkdir(path, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe workspace metadata directory');
  }
  const target = join(root, directoryName);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe project directory');
  } catch (error) { if (!isENOENT(error)) throw error; }
  return { root, target, metadata, transfers: join(metadata, 'transfers') };
}

export async function readBinding(metadata: string): Promise<Binding | undefined> {
  try {
    const value = JSON.parse(await readFile(join(metadata, 'binding.json'), 'utf8')) as Binding;
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.binding) || value.sourceBranch !== null && typeof value.sourceBranch !== 'string') throw new Error('Invalid workspace Git binding');
    if (value.publishBase && (!validOid(value.publishBase.head) || !validOid(value.publishBase.tree))) throw new Error('Invalid publication baseline');
    return value;
  } catch (error) { if (isENOENT(error)) return; throw error; }
}

export const atomicJSON = (path: string, value: unknown) => writeFileAtomic(path, JSON.stringify(value));

/** GNU cp is several times faster than fs.cp on large checkouts and keeps mtimes, so Git's stat cache stays useful. */
async function copyTree(source: string, destination: string, signal: AbortSignal) {
  // The runtime image is Debian; other platforms (local tests) keep the portable copy.
  if (process.platform !== 'linux') return cp(source, destination, { recursive: true, verbatimSymlinks: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cp', ['-a', '--reflink=auto', '-T', '--', source, destination], { signal, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Copying the remote checkout failed: ${diagnostic.trim() || `cp exited with code ${code}`}`)));
  });
}

function validateManifest(value: UploadManifest) {
  if (!value || value.version !== 1 || !validOid(value.head) || !['sha1', 'sha256'].includes(value.objectFormat) ||
      (value.branch !== null && (typeof value.branch !== 'string' || value.branch.length > 1024)) ||
      !value.author || [value.author.name, value.author.email].some(item => typeof item !== 'string' || item.length > 1024 || /[\0\r\n]/.test(item)) ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 3 || !value.files.some(file => file.name === 'bundle') ||
      new Set(value.files.map(file => file.name)).size !== value.files.length ||
      value.files.some(file => !['bundle', 'staged', 'unstaged'].includes(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_TRANSFER_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) || value.files.reduce((sum, file) => sum + file.size, 0) > MAX_TRANSFER_BYTES) {
    throw new Error('Invalid Git transfer manifest');
  }
}

export function createGitRuntime(context: SessionHarnessContext, workspace = process.cwd()) {
  async function handle(command: GitCommand, output?: SessionOutput<GitEvent>, operationSignal = context.signal): Promise<GitResult> {
    if (!command || !/^[a-f0-9]{64}$/.test(command.binding)) throw new Error('Invalid Git workspace binding');
    const paths = await projectPaths(workspace, command.directoryName);
    const project = command.directoryName;
    const current = await readBinding(paths.metadata);
    if (current && current.binding !== command.binding) throw new Error('This remote folder belongs to another local repository. Select a fresh --workspace.');
    const checkGitDirectory = async () => {
      const info = await lstat(join(paths.target, '.git'));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The workspace Git directory is unavailable or unsafe');
    };
    const run = (directory: string, args: string[]) => git(directory, args, { signal: operationSignal });
    const transfer = 'id' in command && validTransferId(command.id) ? join(paths.transfers, command.id) : undefined;
    if ('id' in command && !transfer) throw new Error('Invalid Git transfer identity');
    if (transfer && await exists(transfer) && (!(await lstat(transfer)).isDirectory() || (await lstat(transfer)).isSymbolicLink())) throw new Error('Unsafe Git transfer directory');

    const maintenance = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      const signal = AbortSignal.any([operationSignal, controller.signal]);
      const lease = await acquireCheckout(await context.database(), project, context.session.id, 'maintenance', error => controller.abort(error));
      try {
        signal.throwIfAborted(); await recover();
        const binding = await readBinding(paths.metadata);
        if (binding && binding.binding !== command.binding) throw new Error('This remote folder belongs to another local repository. Select a fresh --workspace.');
        if (binding) await checkGitDirectory();
        return await work(signal);
      }
      finally { await lease.release(); }
    };
    const recover = async () => {
      let journal: Journal;
      try { journal = JSON.parse(await readFile(join(paths.metadata, 'journal.json'), 'utf8')); }
      catch (error) { if (isENOENT(error)) return; throw error; }
      if (!validTransferId(journal.id) || journal.binding.binding !== command.binding) throw new Error('Invalid Git publication journal');
      const candidate = join(paths.transfers, journal.id, 'candidate');
      const backup = join(paths.transfers, journal.id, 'previous');
      if (await exists(candidate)) {
        if (await exists(paths.target)) await rename(paths.target, backup);
        await rename(candidate, paths.target);
      }
      if (!await exists(paths.target)) throw new Error('Interrupted Git publication requires recovery; project data was preserved in its transfer folder.');
      await atomicJSON(join(paths.metadata, 'binding.json'), journal.binding);
      await atomicJSON(join(paths.transfers, journal.id, 'result.json'), { applied: true });
      await rm(join(paths.metadata, 'journal.json'));
      await rm(backup, { recursive: true, force: true });
    };

    switch (command.action) {
      case 'configure': {
        validateRemoteConfiguration(command.configuration);
        if (!current) throw new Error('Initialize the Git workspace before configuring remotes.');
        if (current.sourceBranch !== command.configuration.branch) throw new Error('The local branch changed. Select a fresh --workspace for that branch.');
        const path = join(paths.metadata, 'remotes.json');
        const desired = JSON.stringify(command.configuration);
        const stored = await readFile(path, 'utf8').catch(error => { if (isENOENT(error)) return undefined; throw error; });
        if (stored === desired) return {};
        return maintenance(async signal => {
          const latest = await readFile(path, 'utf8').catch(error => { if (isENOENT(error)) return undefined; throw error; });
          if (latest === desired) return {};
          const previous = latest ? JSON.parse(latest) as GitRemoteConfiguration : undefined;
          await applyRemoteConfiguration(paths.target, command.configuration, previous, signal);
          await atomicJSON(path, command.configuration);
          return {};
        });
      }
      case 'status': {
        if (await exists(join(paths.metadata, 'journal.json'))) await maintenance(async () => {});
        const lease = await acquireCheckout(await context.database(), project, context.session.id, 'session', () => {});
        try {
          const binding = await readBinding(paths.metadata);
          if (!binding) return { status: { initialized: false } };
          await checkGitDirectory();
          return { status: { initialized: true, head: await gitText(paths.target, ['rev-parse', 'HEAD']), sourceBranch: binding.sourceBranch, dirty: !await cleanRepository(paths.target) } };
        } finally { await lease.release(); }
      }
      case 'reap':
        if (!Array.isArray(command.leases) || command.leases.length > 100 || command.leases.some(lease => !validTransferId(lease.token) || typeof lease.session !== 'string')) throw new Error('Invalid stale checkout leases');
        await reapCheckout(await context.database(), project, command.leases);
        return {};
      case 'begin': {
        validateManifest(command.manifest);
        if (command.manifest.branch) await run(paths.root, ['check-ref-format', '--branch', command.manifest.branch]);
        await mkdir(transfer!, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const manifestPath = join(transfer!, 'upload.json');
        if (await exists(manifestPath)) {
          if (await readFile(manifestPath, 'utf8') !== JSON.stringify(command.manifest)) throw new Error('Transfer identity was already used with a different manifest');
        } else await writeFile(manifestPath, JSON.stringify(command.manifest), { flag: 'wx', mode: 0o600 });
        return {};
      }
      case 'chunk': {
        if (!['bundle', 'staged', 'unstaged'].includes(command.file) || !Number.isSafeInteger(command.offset) || command.offset < 0 || typeof command.data !== 'string' || command.data.length > UPLOAD_CHUNK_BYTES / 3 * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.data)) throw new Error('Invalid transfer chunk');
        const manifest = JSON.parse(await readFile(join(transfer!, 'upload.json'), 'utf8')) as UploadManifest;
        const expected = manifest.files.find(file => file.name === command.file);
        const bytes = Buffer.from(command.data, 'base64');
        if (!expected || !bytes.length || command.offset + bytes.length > expected.size) throw new Error('Transfer chunk exceeds its declared file');
        const path = join(transfer!, command.file);
        const file = await open(path, 'a+', 0o600);
        try {
          const size = (await file.stat()).size;
          if (command.offset < size) {
            const previous = Buffer.alloc(bytes.length); await file.read(previous, 0, previous.length, command.offset);
            if (command.offset + bytes.length > size || !previous.equals(bytes)) throw new Error('Conflicting transfer retry');
          } else {
            if (command.offset !== size) throw new Error('Transfer chunk is out of order');
            await file.writeFile(bytes); await file.sync();
          }
          return { offset: (await file.stat()).size };
        } finally { await file.close(); }
      }
      case 'apply': {
        if (command.initializeOnly && current) return {};
        return maintenance(async signal => {
          if (await exists(join(transfer!, 'result.json'))) return {};
          const binding = await readBinding(paths.metadata);
          if (command.initializeOnly && binding) return {};
          const manifest = JSON.parse(await readFile(join(transfer!, 'upload.json'), 'utf8')) as UploadManifest;
          validateManifest(manifest);
          for (const expected of manifest.files) {
            const actual = await fileInfo(join(transfer!, expected.name), expected.name);
            if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error('Incomplete or corrupt Git transfer. Retry the upload.');
          }
          if (!binding && await exists(paths.target) && (await readdir(paths.target)).length) throw new Error('This workspace contains older synced files. Select a fresh --workspace; the existing files were preserved.');
          if (binding && binding.sourceBranch !== manifest.branch) throw new Error('The local branch changed. Select a fresh --workspace for that branch.');
          if (binding && !await cleanRepository(paths.target)) throw new Error('The remote checkout has uncommitted changes. Commit or resolve them before syncing to it.');
          const candidate = join(transfer!, 'candidate');
          await rm(candidate, { recursive: true, force: true });
          if (binding) await copyTree(paths.target, candidate, signal);
          else { await mkdir(candidate); await git(candidate, ['init', `--object-format=${manifest.objectFormat}`], { signal }); }
          // A copied core.worktree setting must never redirect staging operations
          // into the live checkout.
          const candidateGit = (args: string[]) => git(candidate, args, { signal, env: { GIT_DIR: join(candidate, '.git'), GIT_WORK_TREE: candidate } });
          await candidateGit(['bundle', 'verify', join(transfer!, 'bundle')]);
          const refs = (await gitText(candidate, ['bundle', 'list-heads', join(transfer!, 'bundle')])).split('\n');
          if (!refs.some(line => line === `${manifest.head} refs/juiced/transfers/${command.id}`)) throw new Error('The bundle does not contain its declared commit');
          await candidateGit(['fetch', '--no-tags', join(transfer!, 'bundle'), `refs/juiced/transfers/${command.id}:refs/juiced/incoming`]);
          if (binding) {
            const previous = await gitText(candidate, ['rev-parse', 'HEAD']);
            if (!await ancestor(candidate, previous, manifest.head)) throw new Error('Local and remote histories diverged. Import remote commits before reconciling them.');
            await candidateGit(['merge', '--ff-only', '--no-overwrite-ignore', 'refs/juiced/incoming']);
          } else if (manifest.branch) await candidateGit(['checkout', '-b', manifest.branch, manifest.head]);
          else await candidateGit(['checkout', '--detach', manifest.head]);
          for (const name of ['staged', 'unstaged'] as const) {
            if (manifest.files.some(file => file.name === name)) {
              const patch = join(transfer!, name);
              // The candidate has a copied index whose stat cache describes the
              // original files. --index can reject identical contents on copies
              // or NFS. Validate/apply each side independently before publication.
              await candidateGit(['apply', '--check', patch]);
              if (name === 'staged') {
                await candidateGit(['apply', '--cached', '--check', patch]);
                await candidateGit(['apply', '--cached', '--whitespace=nowarn', patch]);
              }
              await candidateGit(['apply', '--whitespace=nowarn', patch]);
            }
          }
          await candidateGit(['config', 'user.name', manifest.author.name]);
          await candidateGit(['config', 'user.email', manifest.author.email]);
          await candidateGit(['config', 'commit.gpgSign', 'false']);
          await candidateGit(['update-ref', '-d', 'refs/juiced/incoming']);
          signal.throwIfAborted();
          const tree = await workingTree(candidate, signal);
          await candidateGit(['update-ref', `refs/juiced/baselines/${tree}`, tree]);
          await atomicJSON(join(paths.metadata, 'journal.json'), { id: command.id, binding: { version: 1, binding: command.binding, sourceBranch: manifest.branch, publishBase: { head: manifest.head, tree } }, hadOriginal: await exists(paths.target) } satisfies Journal);
          await recover();
          return {};
        });
      }
      case 'export': {
        const controller = new AbortController();
        operationSignal = AbortSignal.any([operationSignal, controller.signal]);
        const lease = await acquireCheckout(await context.database(), project, context.session.id, 'session', error => controller.abort(error));
        try {
          if (!validOid(command.known)) throw new Error('Invalid local commit');
          if (!current || await exists(join(paths.metadata, 'journal.json'))) throw new Error('Initialize or recover this Git workspace before importing commits.');
          await checkGitDirectory();
          await mkdir(transfer!, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          const manifestPath = join(transfer!, 'export.json');
          if (await exists(manifestPath)) return { manifest: JSON.parse(await readFile(manifestPath, 'utf8')) };
          if (command.head !== undefined && !validOid(command.head) || command.snapshot !== undefined && typeof command.snapshot !== 'boolean') throw new Error('Invalid publication export');
          const head = command.head ?? await gitText(paths.target, ['rev-parse', 'HEAD']);
          if (await gitText(paths.target, ['rev-parse', `${head}^{commit}`]) !== head) throw new Error('The requested publication is not a commit.');
          const prefix = `refs/juiced/exports/${command.id}`;
          const branches = (await gitText(paths.target, ['for-each-ref', '--format=%(objectname) %(refname:strip=2)', 'refs/heads/'])).split('\n').filter(Boolean);
          const refs = [`${prefix}/head`];
          const updates = [`update ${prefix}/head ${head}`];
          for (const line of branches) {
            const [oid, branch] = line.split(' ');
            if (!validOid(oid) || !branch) throw new Error('Invalid remote branch');
            refs.push(`${prefix}/branches/${branch}`); updates.push(`update ${prefix}/branches/${branch} ${oid}`);
          }
          let snapshot: ExportManifest['snapshot'];
          if (command.snapshot) {
            if (head !== await gitText(paths.target, ['rev-parse', 'HEAD'])) throw new Error('Remote HEAD changed while preparing the snapshot. Retry.');
            const base = current.publishBase ?? { head: command.known, tree: await gitText(paths.target, ['rev-parse', `${command.known}^{tree}`]) };
            const tree = await workingTree(paths.target, operationSignal);
            const patch = await run(paths.target, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', base.tree, tree, '--']);
            await writeFile(join(transfer!, 'snapshot'), patch, { mode: 0o600 });
            snapshot = { baseHead: base.head, baseTree: base.tree, tree, file: await fileInfo(join(transfer!, 'snapshot'), 'snapshot') };
            // Transport-only commits retain both trees in the bundle. No branch,
            // HEAD, working file or real index is changed by snapshot publication.
            for (const [name, oid] of [['baseline', base.tree], ['snapshot', tree]] as const) {
              const commit = (await git(paths.target, ['-c', 'user.name=Juiced', '-c', 'user.email=juiced@localhost', 'commit-tree', oid, '-p', head], { input: 'Juiced snapshot transport\n', signal: operationSignal })).toString().trim();
              refs.push(`${prefix}/${name}`); updates.push(`update ${prefix}/${name} ${commit}`);
            }
          }
          await git(paths.target, ['update-ref', '--stdin'], { input: updates.join('\n') + '\n', signal: operationSignal });
          try {
            const exclusions: string[] = [];
            if (!snapshot && head !== command.known) {
              try { await run(paths.target, ['cat-file', '-e', `${command.known}^{commit}`]); exclusions.push(`^${command.known}`); } catch {}
            }
            await run(paths.target, ['bundle', 'create', join(transfer!, 'bundle'), ...refs, ...exclusions]);
            const file = await fileInfo(join(transfer!, 'bundle'), 'bundle');
            if (file.size + (snapshot?.file.size ?? 0) > MAX_TRANSFER_BYTES) throw new Error('Git export exceeds the 512 MiB transfer limit');
            const manifest: ExportManifest = { head, sourceBranch: current.sourceBranch, file, ...(snapshot ? { snapshot } : {}) };
            await atomicJSON(manifestPath, manifest);
            return { manifest };
          } finally {
            await git(paths.target, ['update-ref', '--stdin'], { input: refs.map(ref => `delete ${ref}`).join('\n') + '\n' }).catch(() => {});
          }
        } finally { await lease.release(); }
      }
      case 'download': {
        if (!output || !Number.isSafeInteger(command.offset) || command.offset < 0) throw new Error('Invalid download request');
        const manifest = JSON.parse(await readFile(join(transfer!, 'export.json'), 'utf8')) as ExportManifest;
        if (command.file !== undefined && !['bundle', 'snapshot'].includes(command.file)) throw new Error('Invalid download file');
        const selected = command.file ?? 'bundle';
        const info = selected === 'bundle' ? manifest.file : manifest.snapshot?.file;
        if (!info || command.offset > info.size) throw new Error('Invalid download offset');
        const extra = selected === 'snapshot' ? { file: selected } : {};
        let offset = command.offset;
        if (offset < info.size) for await (const raw of createReadStream(join(transfer!, selected), { start: offset, highWaterMark: DOWNLOAD_CHUNK_BYTES })) {
          operationSignal.throwIfAborted();
          const bytes = Buffer.from(raw);
          await output.send({ type: 'git-chunk', id: command.id, offset, data: bytes.toString('base64'), ...extra }); offset += bytes.length;
        }
        await output.send({ type: 'git-end', id: command.id, size: info.size, sha256: info.sha256, ...extra });
        return {};
      }
      case 'cleanup':
        if (await exists(join(paths.metadata, 'journal.json'))) throw new Error('Recover the pending Git publication before cleaning up');
        await rm(transfer!, { recursive: true, force: true }); return {};
      default: throw new Error('Unknown Git workspace command');
    }
  }
  return { handle };
}
