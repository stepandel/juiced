import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isENOENT, writeFileAtomic } from './fs-util.js';
import { ancestor, cleanRepository, discoverRepository, git, gitText, sha256, type Repository } from './git.js';
import { GitWorkspaceClient, type GitWorkspace } from './git-workspace.js';
import { validateExportManifest, validTransferId } from './git-protocol.js';
import type { selectProject } from './project.js';
import type { Publication, PublishResult } from './publish-protocol.js';
import { workingTree } from './working-tree.js';

type Project = Awaited<ReturnType<typeof selectProject>>;
type Receipt = { fingerprint: string; result?: PublishResult };

/** A Git ref supplies compare-and-swap locking across clients and linked worktrees. */
async function checkoutLock(root: string) {
  const ref = 'refs/juiced/local-publish-lock';
  const oid = (await git(root, ['hash-object', '-w', '--stdin'], { input: JSON.stringify({ pid: process.pid, nonce: randomUUID() }) })).toString().trim();
  const empty = '0'.repeat(oid.length);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await git(root, ['update-ref', '--no-deref', ref, oid, empty]);
      return async () => { await git(root, ['update-ref', '--no-deref', '-d', ref, oid]); };
    } catch {
      const existing = await gitText(root, ['rev-parse', '--verify', ref]).catch(() => undefined);
      if (!existing) continue;
      let owner: { pid?: number };
      try { owner = JSON.parse((await git(root, ['cat-file', 'blob', existing])).toString()); }
      catch { throw new Error('The local publication lock requires inspection before retrying.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! < 1) throw new Error('Invalid local publication lock.');
      try { process.kill(owner.pid!, 0); throw new Error('Another Juiced client is updating this repository. Retry after it finishes.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      // A dead owner can only be retired if the ref still contains its token.
      await git(root, ['update-ref', '--no-deref', '-d', ref, existing]).catch(() => {});
    }
  }
  throw new Error('Another Juiced client is updating this repository. Retry.');
}

// The receipt guards against applying twice, so it must survive a crash.
const saveJSON = (path: string, value: unknown) => writeFileAtomic(path, JSON.stringify(value));

export class LocalPublisher {
  constructor(private workspace: GitWorkspace, private project: Project, private original: Repository) {}

  async apply(publication: Publication, signal: AbortSignal): Promise<PublishResult> {
    if (!validTransferId(publication.id) || !['commits', 'snapshot'].includes(publication.kind) || !Number.isSafeInteger(publication.expiresAt)) throw new Error('Invalid local publication.');
    validateExportManifest(publication.manifest);
    if ((publication.kind === 'snapshot') !== Boolean(publication.manifest.snapshot)) throw new Error('The publication kind does not match its artifact.');
    const repository = await discoverRepository(this.project.localDirectory);
    if (!repository || repository.root !== this.original.root || repository.binding !== this.original.binding || await realpath(repository.root) !== repository.root)
      throw new Error('The local repository binding changed. Reconnect Juiced.');
    const release = await checkoutLock(repository.root);
    let result: PublishResult;
    try { result = await this.applyLocked(publication, signal, repository); }
    catch (error) { await release().catch(() => {}); throw error; }
    // Local files may already be changed; a lock failure must not be reported as a conflict.
    try { await release(); }
    catch (error) {
      return { ...result, message: `${result.message} The local publication lock could not be released (${error instanceof Error ? error.message : String(error)}); if later publications report a busy repository, delete refs/juiced/local-publish-lock.` };
    }
    return result;
  }

  private async applyLocked(publication: Publication, signal: AbortSignal, repository: Repository): Promise<PublishResult> {
    let client: GitWorkspaceClient | undefined;
    try {
      const root = await gitText(repository.root, ['rev-parse', '--path-format=absolute', '--git-path', 'juiced-publications']);
      const directory = join(root, sha256(this.project.scope?JSON.stringify([this.project.scope,this.project.workspace]):this.project.workspace), publication.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const receiptPath = join(directory, 'receipt.json');
      const fingerprint = sha256(JSON.stringify({ kind: publication.kind, manifest: publication.manifest }));
      let receipt: Receipt | undefined;
      try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
      catch (error) { if (!isENOENT(error)) throw error; }
      if (receipt?.fingerprint !== undefined && receipt.fingerprint !== fingerprint) throw new Error('This publication identity was used for different contents.');
      if (receipt?.result) return { status: 'already-applied', message: 'This publication was already applied locally; no files were changed again.' };
      const check = async () => {
        signal.throwIfAborted();
        if (Date.now() >= publication.expiresAt) throw new Error('The publication expired. Request it again from Claude.');
        const branch = await gitText(repository.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
        if (branch !== this.original.branch || branch !== publication.manifest.sourceBranch) throw new Error('The local source branch changed. Check out the original branch and retry.');
        return gitText(repository.root, ['rev-parse', 'HEAD']);
      };
      const initialHead = await check();
      client = new GitWorkspaceClient(this.workspace, this.project, repository, signal);
      const imported = await client.receive(publication);
      await saveJSON(join(directory, 'publication.json'), publication);
      await saveJSON(receiptPath, { fingerprint });
      const complete = async (status: 'applied' | 'already-applied', message: string): Promise<PublishResult> => {
        const result = { status, message };
        await saveJSON(receiptPath, { fingerprint, result });
        return result;
      };
      if (publication.kind === 'commits') {
        if (!this.original.branch) throw new Error('Commit publication requires a local branch; HEAD is detached.');
        const head = await check();
        if (head === imported.head) return complete('already-applied', `Commit ${head.slice(0, 12)} is already checked out locally.`);
        if (head !== initialHead) throw new Error('Local HEAD changed during the import. Retry publication.');
        if (!await cleanRepository(repository.root)) throw new Error(`Commits imported into ${imported.ref}. The local checkout must be clean before applying commits.`);
        if (!await ancestor(repository.root, head, imported.head)) throw new Error(`Commits imported into ${imported.ref}. Local and remote histories diverged; reconcile them with Git.`);
        if (await check() !== head || !await cleanRepository(repository.root)) throw new Error('The local checkout changed before application. Retry.');
        await git(repository.root, ['merge', '--ff-only', '--no-overwrite-ignore', imported.head], { signal });
        return complete('applied', `Fast-forwarded local ${this.original.branch} to ${imported.head.slice(0, 12)}.`);
      }

      const snapshot = publication.manifest.snapshot!;
      await writeFile(join(directory, 'snapshot.patch'), imported.patch!, { mode: 0o600 });
      if (await check() !== snapshot.baseHead) throw new Error(`The local commit no longer matches snapshot baseline ${snapshot.baseHead.slice(0, 12)}. The imported snapshot was retained for review.`);
      const names = await git(repository.root, ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-only', '-z', snapshot.baseTree, snapshot.tree, '--'], { signal });
      const paths = new TextDecoder('utf-8', { fatal: true }).decode(names).split('\0').filter(Boolean);
      if (paths.length > 4096 || names.length > 128 * 1024) throw new Error('This snapshot has too many changed paths. Publish a smaller change.');
      for (const path of paths) {
        if (path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('The snapshot contains an unsafe path.');
        let parent = repository.root;
        for (const part of path.split('/').slice(0, -1)) {
          parent = join(parent, part);
          try { if (!(await lstat(parent)).isDirectory()) throw new Error(`A snapshot path has a symlink or non-directory ancestor: ${path}`); }
          catch (error) { if (!isENOENT(error)) throw error; break; }
        }
      }
      const matches = async (expected: string, actual: string) => !(await git(repository.root, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', expected, actual, '--', ...paths], { env: { GIT_LITERAL_PATHSPECS: '1' }, signal })).length;
      if (!paths.length) return complete('already-applied', 'The remote snapshot has no new file edits.');
      const before = await workingTree(repository.root, signal);
      if (await matches(snapshot.tree, before)) return complete('already-applied', 'These snapshot edits are already present locally; the index was preserved.');
      if (!await matches(snapshot.baseTree, before)) throw new Error(`Local edits overlap this snapshot. Nothing was applied. Review ${join(directory, 'snapshot.patch')}`);
      await git(repository.root, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], { input: imported.patch!, signal });
      if (await check() !== snapshot.baseHead || !await matches(snapshot.baseTree, await workingTree(repository.root, signal))) throw new Error('Local files changed before snapshot application. Retry.');
      // Git applies the checked patch without --index or --reject: local staging
      // is preserved, and an ordinary patch rejection does not apply a subset.
      await git(repository.root, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: imported.patch!, signal });
      return complete('applied', `Applied ${paths.length} snapshot path${paths.length === 1 ? '' : 's'} as local uncommitted edits; the index was preserved.`);
    } finally { await client?.close().catch(() => {}); }
  }
}
