import { randomUUID } from 'node:crypto';
import { RemoteAppError } from '@cantelop/sdk';
import type { TerminalCommand, TerminalReply } from '../protocol.js';
import type { Approval } from '../agent-protocol.js';
import { validateExportManifest, validOid, validTransferId } from '../git-protocol.js';
import type { LocalTransfer, Publication, PublishResult, UploadRequest } from '../publish-protocol.js';
import { withTimeout } from '../transport.js';
import { validateLocalFilesRequest } from '../local-files-protocol.js';
import type { LocalFiles } from '../local-files.js';

export type LocalPublish = {
  head: string; apply(publication: Publication, signal: AbortSignal): Promise<PublishResult>;
  upload?: { prepare(request: UploadRequest, signal: AbortSignal): Promise<Record<string, unknown>>; send(request: UploadRequest, signal: AbortSignal): Promise<PublishResult>; discard(id: string): Promise<void> };
  files?: Pick<LocalFiles, 'prepare' | 'send' | 'discard'>;
};

/**
 * Remote requests only download the artifact or send the upload, before either
 * checkout is changed. Say so, so Claude does not mistake a capacity or
 * connection error for a file conflict or a missing approval.
 */
export function transferFailure(transfer: LocalTransfer, error: unknown, fallback: string): PublishResult {
  const message = (error instanceof Error ? error.message : fallback).slice(0, 2000);
  // The SDK types request failures; GitWorkspaceClient also types stream failures
  // at the subscription boundary. Local Git/filesystem errors keep their origin.
  if (!(error instanceof RemoteAppError)) return { status: 'conflict', message };
  if (transfer.kind === 'files') return { status: 'failed', message: `The local file request failed (${message}). Reconnect Juiced and retry the request. Check the remote destination if application had started.` };
  if (transfer.kind === 'upload')
    return { status: 'failed', message: `Juiced could not send the local changes to the workspace (${message}). This was a connection or capacity error, not a conflict; the remote checkout was not changed and the local client is still attached. Retry pull_local_changes in a minute.` };
  const recovery = transfer.kind === 'snapshot'
    ? 'Retry publish_snapshot in a minute, or commit the edits remotely and ask the user to run juiced claude sync --from-workspace locally.'
    : 'Retry publish_commits in a minute, or ask the user to run juiced claude fast-forward locally.';
  return { status: 'failed', message: `Juiced could not download this publication from the workspace (${message}). This was a connection or capacity error, not a file conflict, and the local approval was received. Local files, HEAD and the index were not changed, and the local client is still attached. ${recovery}` };
}

const FILE_TOOLS = { list: 'List local files', pull: 'Pull local files' } as const;
const TRANSFER_TOOLS = { upload: 'Upload local changes', commits: 'Publish commits', snapshot: 'Publish snapshot' } as const;
const DECLINED: Record<LocalTransfer['kind'], string> = {
  files: 'The user declined the request. No local files or listing were sent.',
  upload: 'The user declined the upload. No local files were sent.',
  commits: 'The user declined local application. Local files were not changed.',
  snapshot: 'The user declined local application. Local files were not changed.',
};

/** The agent state a broker shares: its approval list, events, runtime requests and lifetime. */
export type PublicationHost = {
  readonly approvals: Map<string, Approval>;
  emit(event: string, ...args: unknown[]): boolean;
  request(command: TerminalCommand): Promise<TerminalReply>;
  signal: AbortSignal;
  localPublish: LocalPublish | undefined;
};

/** Remote publication offers surfaced as local approvals, applied to the local checkout at most once. */
export class PublicationBroker {
  private client = randomUUID();
  private publications = new Map<string, LocalTransfer>();
  private finished = new Set<string>();
  private work = new Set<Promise<unknown>>();
  private controllers = new Map<string, AbortController>();

  constructor(private host: PublicationHost) {
    host.signal.addEventListener('abort', () => this.reset(), { once: true });
  }

  offer(publication: LocalTransfer) {
    if (!this.host.localPublish || this.publications.has(publication.id) || this.finished.has(publication.id) || publication.expiresAt <= Date.now()) return;
    if (!validTransferId(publication.id) || typeof publication.summary !== 'string' || publication.summary.length > 2000 || !Number.isSafeInteger(publication.expiresAt)) throw new Error('Invalid publication offer');
    if (publication.kind === 'files') validateLocalFilesRequest(publication);
    else if (publication.kind === 'upload') {
      if (!validOid(publication.head) || typeof publication.includeUncommitted !== 'boolean' || publication.sourceBranch !== null && typeof publication.sourceBranch !== 'string') throw new Error('Invalid upload offer');
    } else {
      if (!['commits', 'snapshot'].includes(publication.kind) || !Number.isSafeInteger(publication.fileCount) || publication.fileCount < 0 ||
          !Array.isArray(publication.paths) || publication.paths.length > 20 || publication.paths.some(path => typeof path !== 'string' || path.length > 200)) throw new Error('Invalid publication offer');
      validateExportManifest(publication.manifest);
    }
    this.publications.set(publication.id, publication);
    const controller = new AbortController();
    this.controllers.set(publication.id, controller);
    // Verify a replayed offer is still pending before capturing any local work.
    const work = this.host.request({ type: 'publish-status', id: publication.id }).then(async () => {
      let input: Record<string, unknown>;
      if (publication.kind === 'files' || publication.kind === 'upload') {
        try {
          const { files, upload } = this.host.localPublish ?? {};
          const prepare = publication.kind === 'files' ? files && ((signal: AbortSignal) => files.prepare(publication, signal))
            : upload && ((signal: AbortSignal) => upload.prepare(publication, signal));
          if (!prepare) throw new Error('This local client does not support this transfer. Rebuild Juiced.');
          input = await withTimeout(this.host.signal, Math.max(1, publication.expiresAt - Date.now()), expiry => prepare(AbortSignal.any([expiry, controller.signal])));
        } catch (error) {
          if (!controller.signal.aborted) {
            await this.host.request({ type: 'publish-claim', id: publication.id, client: this.client });
            await this.host.request({ type: 'publish-result', id: publication.id, client: this.client, result: transferFailure(publication, error, 'Local capture failed.') });
          }
          this.done(publication.id);
          return;
        }
      } else {
        const snapshot = publication.manifest.snapshot;
        input = { commit: publication.manifest.head,
          ...(snapshot ? { baseline: snapshot.baseHead, baselineTree: snapshot.baseTree, snapshotTree: snapshot.tree } : {}),
          files: publication.fileCount, paths: publication.paths,
          ...(publication.fileCount > publication.paths.length ? { preview: 'First 20 paths shown' } : {}) };
      }
      if (this.finished.has(publication.id) || publication.expiresAt <= Date.now() || this.host.signal.aborted || controller.signal.aborted) { this.discard(publication.id); return; }
      this.host.approvals.set(publication.id, { id: publication.id, local: true, ...(publication.kind === 'upload' ? { upload: true } : {}),
        ...(publication.kind === 'files' ? { localFiles: publication.action } : {}),
        tool: publication.kind === 'files' ? FILE_TOOLS[publication.action] : TRANSFER_TOOLS[publication.kind], description: publication.summary, input });
      this.host.emit('approvals');
    }).catch(() => { this.publications.delete(publication.id); this.controllers.delete(publication.id); this.discard(publication.id); });
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
  }

  async answer(id: string, allow: boolean): Promise<void> {
    const work = this.apply(id, allow);
    this.work.add(work);
    try { await work; } finally { this.work.delete(work); }
  }

  private async apply(id: string, allow: boolean) {
    const publication = this.publications.get(id);
    if (!publication || this.finished.has(id)) throw new Error('This publication is no longer active.');
    this.finished.add(id);
    this.host.approvals.delete(id); this.host.emit('approvals');
    const controller = this.controllers.get(id) ?? new AbortController();
    this.controllers.set(id, controller);
    try {
      await this.host.request({ type: 'publish-claim', id, client: this.client });
      let result: PublishResult = { status: 'declined', message: DECLINED[publication.kind] };
      if (allow) {
        try {
          result = await withTimeout(this.host.signal, Math.max(1, publication.expiresAt - Date.now()), async expiry => {
            const signal = AbortSignal.any([expiry, controller.signal]);
            signal.throwIfAborted();
            if (publication.kind === 'files') return this.host.localPublish!.files!.send(publication, signal, command => {
              signal.throwIfAborted();
              return this.host.request({ ...command, client: this.client });
            });
            return publication.kind === 'upload' ? this.host.localPublish!.upload!.send(publication, signal) : this.host.localPublish!.apply(publication, signal);
          });
        } catch (error) { result = transferFailure(publication, error, 'Local application failed. Check the local checkout before retrying.'); }
      }
      const reply = await this.host.request({ type: 'publish-result', id, client: this.client, result });
      if (reply.ok && reply.publication) result = reply.publication;
      this.host.emit('frame', { type: 'juiced_publish', id, message: result.message, failed: !['applied', 'already-applied'].includes(result.status) });
    } finally { this.publications.delete(id); this.controllers.delete(id); this.discard(id); }
  }

  /** The runtime finished this publication elsewhere (or it expired); stop any local application. */
  done(id: string) {
    this.controllers.get(id)?.abort(new Error('The remote publication ended. Check the local checkout.'));
    this.finished.add(id); this.publications.delete(id); this.controllers.delete(id); this.discard(id);
    this.host.approvals.delete(id); this.host.emit('approvals');
  }

  private discard(id: string) {
    for (const handler of [this.host.localPublish?.upload, this.host.localPublish?.files]) {
      const cleanup = handler?.discard(id).catch(() => {});
      if (cleanup) { this.work.add(cleanup); void cleanup.finally(() => this.work.delete(cleanup)); }
    }
  }

  /** A new Claude process never inherits in-flight applications. */
  reset() {
    for (const id of this.controllers.keys()) this.done(id);
  }

  async settled(): Promise<void> {
    // Captures can schedule artifact cleanup while an earlier batch settles.
    while (this.work.size) await Promise.allSettled([...this.work]);
  }
}
