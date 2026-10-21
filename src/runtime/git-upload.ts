import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ancestor, git, gitText } from '../git.js';
import { MAX_TRANSFER_BYTES, validOid, type UploadManifest } from '../git-protocol.js';
import { workingTree } from '../working-tree.js';

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

export function validateUploadManifest(value: UploadManifest) {
  if (!value || value.version !== 1 || !validOid(value.head) || !['sha1', 'sha256'].includes(value.objectFormat) ||
      (value.branch !== null && (typeof value.branch !== 'string' || value.branch.length > 1024)) ||
      !value.author || [value.author.name, value.author.email].some(item => typeof item !== 'string' || item.length > 1024 || /[\0\r\n]/.test(item)) ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 3 || !value.files.some(file => file.name === 'bundle') ||
      new Set(value.files.map(file => file.name)).size !== value.files.length ||
      value.files.some(file => !['bundle', 'staged', 'unstaged'].includes(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_TRANSFER_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) || value.files.reduce((sum, file) => sum + file.size, 0) > MAX_TRANSFER_BYTES) {
    throw new Error('Invalid Git transfer manifest');
  }
}

/** Validate a prepared checkout before either offline replacement or a live upload. */
export async function prepareUploadCandidate(target: string, transfer: string, id: string, manifest: UploadManifest, binding: boolean, signal: AbortSignal) {
  const candidate = join(transfer, 'candidate');
  await rm(candidate, { recursive: true, force: true });
  if (binding) await copyTree(target, candidate, signal);
  else { await mkdir(candidate); await git(candidate, ['init', `--object-format=${manifest.objectFormat}`], { signal }); }
  // A copied core.worktree setting must never redirect staging operations
  // into the live checkout.
  const candidateGit = (args: string[]) => git(candidate, args, { signal, env: { GIT_DIR: join(candidate, '.git'), GIT_WORK_TREE: candidate } });
  await candidateGit(['bundle', 'verify', join(transfer, 'bundle')]);
  const refs = (await gitText(candidate, ['bundle', 'list-heads', join(transfer, 'bundle')])).split('\n');
  if (!refs.some(line => line === `${manifest.head} refs/juiced/transfers/${id}`)) throw new Error('The bundle does not contain its declared commit');
  await candidateGit(['fetch', '--no-tags', join(transfer, 'bundle'), `refs/juiced/transfers/${id}:refs/juiced/incoming`]);
  if (binding) {
    const previous = await gitText(candidate, ['rev-parse', 'HEAD']);
    if (!await ancestor(candidate, previous, manifest.head)) throw new Error('Local and remote histories diverged. Import remote commits before reconciling them.');
    await candidateGit(['merge', '--ff-only', '--no-overwrite-ignore', 'refs/juiced/incoming']);
  } else if (manifest.branch) await candidateGit(['checkout', '-b', manifest.branch, manifest.head]);
  else await candidateGit(['checkout', '--detach', manifest.head]);
  for (const name of ['staged', 'unstaged'] as const) {
    if (manifest.files.some(file => file.name === name)) {
      const patch = join(transfer, name);
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
  const indexTree = await gitText(candidate, ['write-tree'], { signal });
  return { candidate, tree, indexTree };
}
