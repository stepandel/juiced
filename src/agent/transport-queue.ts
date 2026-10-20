import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_AGENT_INPUT_BYTES, MAX_BUFFERED_INPUT, MAX_INPUT_BYTES, type TerminalCommand, type TerminalReply } from '../protocol.js';
import type { ClaudeFrame } from '../agent-protocol.js';
import { backoffMs, isTransient, messageId, withTimeout } from '../transport.js';
import type { AgentSession } from '../remote-agent.js';

/** The runtime or Claude process refused the request; never retried as a dropped connection. */
export class RemoteProcessError extends Error {}
export const processChanged = (error: unknown) => error instanceof RemoteProcessError && error.message === 'The Claude process changed. Reconnect before submitting input.';

/** What the queue reports back to its agent: reconnect events, debug traces and fatal delivery failures. */
export type TransportHost = {
  emit(event: string, ...args: unknown[]): boolean;
  debug(event: string, detail?: object): void;
  fail(error: unknown): void;
};

/** Ordered, size-bounded delivery of Claude input and retried runtime requests for one agent. */
export class TransportQueue {
  private pending = Promise.resolve();
  private pendingBytes = 0;

  constructor(private session: AgentSession, private signal: AbortSignal, private host: TransportHost) {}

  async request(command: TerminalCommand, id = messageId()): Promise<TerminalReply> {
    for (let failures = 0; ; failures++) {
      this.signal.throwIfAborted();
      try {
        const reply = await withTimeout(this.signal, 125_000, signal => this.session.request(command, { id, timeoutMs: 120_000, signal }));
        if (!reply.ok) throw new RemoteProcessError(reply.error);
        if (failures) this.host.emit('reconnected');
        return reply;
      } catch (error) {
        if (this.signal.aborted) throw this.signal.reason;
        if (!isTransient(error) || error instanceof RemoteProcessError) throw error;
        this.host.emit('reconnecting', failures + 1);
        await delay(backoffMs(failures), undefined, { signal: this.signal });
      }
    }
  }

  private enqueue(command: TerminalCommand, bytes: number, retryProcessChange = false): Promise<void> {
    if (this.pendingBytes + bytes > MAX_BUFFERED_INPUT) return Promise.reject(new Error('Too much input is waiting for Cantelop'));
    this.pendingBytes += bytes;
    const next = this.pending.then(async () => {
      this.signal.throwIfAborted();
      const start = Date.now();
      this.host.debug('control.dispatch', { type: command.type });
      // Serialize durable handoff receipts and legacy dispatch acceptance;
      // keyboard editing remains independent of this queue.
      if (command.type === 'agent-input') await this.request(command, messageId(command.id));
      else await withTimeout(this.signal, 35_000, signal => this.session.dispatch(command, { signal }));
      this.host.debug('control.accepted', { type: command.type, elapsedMs: Date.now() - start });
    }).finally(() => { this.pendingBytes -= bytes; });
    this.pending = next.catch(() => {});
    void next.catch(error => {
      // A menu read can reopen and retry an explicitly rejected stale epoch.
      // Ambiguous delivery failures and mutations retain their normal handling.
      if (!retryProcessChange || !processChanged(error)) this.host.fail(error);
    });
    return next;
  }

  encode(frame: ClaudeFrame): Buffer {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > MAX_BUFFERED_INPUT) throw new Error('The submitted message is too large (maximum 1 MiB)');
    if (this.pendingBytes + bytes.length > MAX_BUFFERED_INPUT) throw new Error('Too much input is waiting for Cantelop');
    return bytes;
  }

  /** `durable` carries the agent epoch; without it the bytes go out as legacy terminal input. */
  async sendBytes(bytes: Buffer, durable: { epoch: string } | undefined, retryProcessChange = false): Promise<void> {
    if (durable) {
      if (bytes.length > MAX_AGENT_INPUT_BYTES) throw new Error('The submitted message is too large');
      await this.enqueue({ type: 'agent-input', id: randomUUID(), epoch: durable.epoch, frame: JSON.parse(bytes.toString()) as ClaudeFrame }, bytes.length, retryProcessChange);
      return;
    }
    // Queue all fragments synchronously: no other frame may interleave them.
    const writes: Promise<void>[] = [];
    for (let offset = 0; offset < bytes.length; offset += MAX_INPUT_BYTES) {
      const chunk = bytes.subarray(offset, offset + MAX_INPUT_BYTES);
      writes.push(this.enqueue({ type: 'input', data: chunk.toString('base64') }, chunk.length));
    }
    await Promise.all(writes);
  }
}
