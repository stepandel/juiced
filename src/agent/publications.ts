import { randomUUID } from 'node:crypto';
import type { TerminalCommand, TerminalReply } from '../protocol.js';
import type { Approval } from '../agent-protocol.js';
import { validateExportManifest, validTransferId } from '../git-protocol.js';
import type { Publication, PublishResult } from '../publish-protocol.js';
import { withTimeout } from '../transport.js';

export type LocalPublish = { head: string; apply(publication: Publication, signal: AbortSignal): Promise<PublishResult> };

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
  private publications = new Map<string, Publication>();
  private finished = new Set<string>();
  private work = new Set<Promise<unknown>>();
  private controllers = new Map<string, AbortController>();

  constructor(private host: PublicationHost) {}

  offer(publication: Publication) {
    if (!this.host.localPublish || this.publications.has(publication.id) || this.finished.has(publication.id) || publication.expiresAt <= Date.now()) return;
    if (!validTransferId(publication.id)
      || !['commits', 'snapshot'].includes(publication.kind)
      || typeof publication.summary !== 'string'
      || publication.summary.length > 2000
      || !Number.isSafeInteger(publication.expiresAt)
      || !Number.isSafeInteger(publication.fileCount)
      || publication.fileCount < 0
      || !Array.isArray(publication.paths)
      || publication.paths.length > 20
      || publication.paths.some(path => typeof path !== 'string' || path.length > 200)) throw new Error('Invalid publication offer');
    validateExportManifest(publication.manifest);
    this.publications.set(publication.id, publication);
    // Replayed offers must still be pending in the live runtime. A journal
    // entry from a completed or lost native process never authorizes a write.
    const work = this.host.request({ type: 'publish-status', id: publication.id }).then(() => {
      if (this.finished.has(publication.id) || publication.expiresAt <= Date.now() || this.host.signal.aborted) return;
      const snapshot = publication.manifest.snapshot;
      this.host.approvals.set(publication.id, { id: publication.id, local: true, tool: publication.kind === 'commits' ? 'Publish commits' : 'Publish snapshot', description: publication.summary,
        input: {
          commit: publication.manifest.head,
          ...(snapshot ? { baseline: snapshot.baseHead, baselineTree: snapshot.baseTree, snapshotTree: snapshot.tree } : {}),
          files: publication.fileCount, paths: publication.paths,
          ...(publication.fileCount > publication.paths.length ? { preview: 'First 20 paths shown' } : {}),
        } });
      this.host.emit('approvals');
    }).catch(() => { this.publications.delete(publication.id); });
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
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      await this.host.request({ type: 'publish-claim', id, client: this.client });
      let result: PublishResult = { status: 'declined', message: 'The user declined local application. Local files were not changed.' };
      if (allow) {
        try {
          result = await withTimeout(this.host.signal, Math.max(1, publication.expiresAt - Date.now()), async expiry => {
            const signal = AbortSignal.any([expiry, controller.signal]);
            signal.throwIfAborted();
            return this.host.localPublish!.apply(publication, signal);
          });
        } catch (error) { result = { status: 'conflict', message: error instanceof Error ? error.message : 'Local application failed. Check the local checkout before retrying.' }; }
      }
      this.host.emit('frame', { type: 'juiced_publish', id, message: result.message, failed: !['applied', 'already-applied'].includes(result.status) });
      await this.host.request({ type: 'publish-result', id, client: this.client, result });
    } finally { this.publications.delete(id); this.controllers.delete(id); }
  }

  /** The runtime finished this publication elsewhere (or it expired); stop any local application. */
  done(id: string) {
    this.controllers.get(id)?.abort(new Error('The remote publication ended. Check the local checkout.'));
    this.finished.add(id); this.publications.delete(id);
    this.host.approvals.delete(id); this.host.emit('approvals');
  }

  /** A new Claude process never inherits in-flight applications. */
  reset() {
    for (const [id, controller] of this.controllers) { this.finished.add(id); controller.abort(new Error('The remote Claude process changed.')); }
  }

  settled(): Promise<unknown> { return Promise.allSettled(this.work); }
}
