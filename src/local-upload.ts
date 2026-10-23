import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ancestor, createUpload, discoverRepository, git, gitText, GitError, type Repository } from './git.js';
import { GitWorkspaceClient, type GitWorkspace } from './git-workspace.js';
import type { selectProject } from './project.js';
import type { PublishResult, UploadRequest } from './publish-protocol.js';

/** Pin bytes before approval. Nothing leaves the laptop until Send is chosen. */
export class LocalUploader {
  private prepared = new Map<string, Awaited<ReturnType<typeof createUpload>>>();
  constructor(private workspace: GitWorkspace, private project: Awaited<ReturnType<typeof selectProject>>, private original: Repository) {}

  async prepare(request: UploadRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const repository = await discoverRepository(this.project.localDirectory);
    if (!repository || repository.root !== this.original.root || repository.binding !== this.original.binding ||
        repository.branch !== this.original.branch || repository.branch !== request.sourceBranch)
      throw new Error('The local repository or source branch changed. Reconnect from its original checkout.');
    const known = await gitText(repository.root, ['rev-parse', '--verify', '--quiet', `${request.head}^{commit}`]).catch(error => {
      if (error instanceof GitError && error.code === 1) return undefined;
      throw error;
    });
    if (!known || !await ancestor(repository.root, request.head, repository.head))
      throw new Error('The laptop does not contain the remote HEAD. Import and reconcile remote commits before uploading local work.');
    const upload = await createUpload(repository, request.includeUncommitted, request.head, signal, request.uploadParts === true);
    try {
      // Reconstruct the pinned tree with a private index for an exact path preview.
      const env = { GIT_INDEX_FILE: join(upload.directory, 'preview-index') };
      const run = (args: string[], input?: Buffer) => git(repository.root, args, { env, signal, ...(input ? { input } : {}) });
      await run(['read-tree', upload.manifest.head]);
      for (const name of ['staged', 'unstaged'] as const) if (upload.manifest.files.some(file => file.name === name))
        await run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], await readFile(join(upload.directory, name)));
      const tree = (await run(['write-tree'])).toString().trim();
      const names = await git(repository.root, ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-only', '-z', request.head, tree, '--'], { signal });
      const paths = names.toString().split('\0').filter(Boolean);
      if (paths.length > 4096 || names.length > 128 * 1024) throw new Error('This upload has too many changed paths. Send a smaller change.');
      signal.throwIfAborted();
      await this.discard(request.id);
      this.prepared.set(request.id, upload);
      return { directory: repository.root, commit: upload.manifest.head, includeUncommitted: request.includeUncommitted,
        files: paths.length, paths: paths.slice(0, 20), bytes: upload.manifest.files.reduce((sum, file) => sum + file.size, 0),
        ...(paths.length > 20 ? { preview: 'First 20 paths shown' } : {}) };
    } catch (error) { await upload.close(); throw error; }
  }

  async send(request: UploadRequest, signal: AbortSignal): Promise<PublishResult> {
    const upload = this.prepared.get(request.id);
    if (!upload) throw new Error('The approved local snapshot is no longer available. Request another upload.');
    const client = new GitWorkspaceClient(this.workspace, this.project, this.original, signal);
    try {
      await client.uploadPrepared(upload);
      return { status: 'applied', uploadId: upload.id, message: 'Uploaded the approved local snapshot; awaiting remote application.' };
    } finally { await client.close().catch(() => {}); }
  }

  async discard(id: string) {
    const upload = this.prepared.get(id);
    this.prepared.delete(id);
    await upload?.close();
  }
}
