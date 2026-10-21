import { randomUUID } from 'node:crypto';
import type { TerminalCommand, TerminalReply } from '../protocol.js';
import type { Approval } from '../agent-protocol.js';
import { validateExportManifest, validOid, validTransferId } from '../git-protocol.js';
import type { LocalTransfer, Publication, PublishResult, UploadRequest } from '../publish-protocol.js';
import { withTimeout } from '../transport.js';

export type LocalPublish = {
  head: string; apply(publication: Publication, signal: AbortSignal): Promise<PublishResult>;
  upload?: { prepare(request: UploadRequest, signal: AbortSignal): Promise<Record<string, unknown>>; send(request: UploadRequest, signal: AbortSignal): Promise<PublishResult>; discard(id: string): Promise<void> };
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
    if (publication.kind === 'upload') {
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
      if (publication.kind === 'upload') {
        try {
          if (!this.host.localPublish?.upload) throw new Error('This local client does not support uploads. Rebuild Juiced.');
          input = await withTimeout(this.host.signal, Math.max(1, publication.expiresAt - Date.now()), expiry =>
            this.host.localPublish!.upload!.prepare(publication, AbortSignal.any([expiry, controller.signal])));
        } catch (error) {
          if (!controller.signal.aborted) {
            await this.host.request({ type: 'publish-claim', id: publication.id, client: this.client });
            await this.host.request({ type: 'publish-result', id: publication.id, client: this.client, result: { status: 'conflict', message: error instanceof Error ? error.message : 'Local capture failed.' } });
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
        tool: publication.kind === 'upload' ? 'Upload local changes' : publication.kind === 'commits' ? 'Publish commits' : 'Publish snapshot', description: publication.summary, input });
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
      let result: PublishResult = { status: 'declined', message: publication.kind === 'upload' ? 'The user declined the upload. No local files were sent.' : 'The user declined local application. Local files were not changed.' };
      if (allow) {
        try {
          result = await withTimeout(this.host.signal, Math.max(1, publication.expiresAt - Date.now()), async expiry => {
            const signal = AbortSignal.any([expiry, controller.signal]);
            signal.throwIfAborted();
            return publication.kind === 'upload' ? this.host.localPublish!.upload!.send(publication, signal) : this.host.localPublish!.apply(publication, signal);
          });
        } catch (error) { result = { status: 'conflict', message: error instanceof Error ? error.message : 'Local application failed. Check the local checkout before retrying.' }; }
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
    const cleanup = this.host.localPublish?.upload?.discard(id).catch(() => {});
    if (cleanup) { this.work.add(cleanup); void cleanup.finally(() => this.work.delete(cleanup)); }
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
