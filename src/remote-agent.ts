import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionEventCursor, SessionRef } from '@cantelop/sdk';
import { MAX_BUFFERED_INPUT, MAX_INPUT_BYTES, type TerminalCommand, type TerminalEvent, type TerminalReply } from './protocol.js';
import { ClaudeDecoder, headlessArguments, object, slashCommands, type Approval, type ClaudeFrame, type SlashCommand } from './agent-protocol.js';

export type AgentSession = Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'id' | 'request' | 'dispatch' | 'stream' | 'stop'>;
export type AgentStatus = 'connecting' | 'ready' | 'working' | 'interrupting' | 'closed' | 'failed';
type Control = { resolve(value: ClaudeFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
class RemoteProcessError extends Error {}

/** A headless Claude process on Cantelop. Keyboard editing never enters this class. */
export class RemoteAgent extends EventEmitter {
  status: AgentStatus = 'connecting';
  readonly approvals = new Map<string, Approval>();
  commands: SlashCommand[] = [];
  private controller = new AbortController();
  private decoder = new ClaudeDecoder();
  private controls = new Map<string, Control>();
  private pending = Promise.resolve();
  private pendingBytes = 0;
  private submission = 0;
  private reader: Promise<void> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  private started = false;
  private cursor: SessionEventCursor | undefined;
  private diagnostic = '';

  constructor(readonly session: AgentSession, private options: { controlTimeoutMs?: number; heartbeatMs?: number; stopTimeoutMs?: number; directoryName?: string; git?: { binding: string; relativeDirectory: string }; beforeSubmit?: () => Promise<void> } = {}) { super(); }

  private debug(event: string, detail: object = {}) {
    if (process.env.JUICED_DEBUG) console.error(JSON.stringify({ session: this.session.id, event, ...detail }));
  }
  private setStatus(status: AgentStatus) { this.status = status; this.debug('agent.status', { status }); this.emit('status', status); }
  private fail(error: unknown) {
    if (this.controller.signal.aborted) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.setStatus('failed');
    this.emit('failure', failure);
    this.controller.abort(failure);
    this.rejectControls(failure);
  }
  private rejectControls(error: Error) {
    for (const control of this.controls.values()) { clearTimeout(control.timer); control.reject(error); }
    this.controls.clear();
  }

  async start(argv: string[] = []): Promise<void> {
    if (this.started) throw new Error('The agent has already started');
    this.started = true;
    try {
      const reply = await this.session.request({ type: 'start', argv: headlessArguments(argv), tty: false, columns: 120, rows: 36, term: 'dumb', ...(this.options.directoryName ? { directoryName: this.options.directoryName } : {}), ...(this.options.git ? { git: this.options.git } : {}) }, { timeoutMs: 120_000, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(125_000)]) });
      if (reply?.ok !== true) throw new Error('Cantelop could not start Claude');
      this.reader = this.read();
      void this.reader.catch(error => this.fail(error));
      this.heartbeat = setInterval(() => {
        void this.enqueue({ type: 'heartbeat' }, 0).catch(error => this.fail(error));
      }, this.options.heartbeatMs ?? 30_000);
      this.heartbeat.unref();
      const initialized = await this.control({ subtype: 'initialize', hooks: null });
      this.updateCommands(initialized.commands);
      this.setStatus('ready');
    } catch (error) { this.fail(error); throw error; }
  }

  private enqueue(command: TerminalCommand, bytes: number): Promise<void> {
    if (this.pendingBytes + bytes > MAX_BUFFERED_INPUT) return Promise.reject(new Error('Too much input is waiting for Cantelop'));
    this.pendingBytes += bytes;
    const next = this.pending.then(async () => {
      this.controller.signal.throwIfAborted();
      const start = Date.now();
      this.debug('control.dispatch', { type: command.type });
      // Await durable acceptance to preserve input order, rather than waiting
      // for the runtime's reply to every submitted prompt or control message.
      await this.session.dispatch(command, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(35_000)]) });
      this.debug('control.accepted', { type: command.type, elapsedMs: Date.now() - start });
    }).finally(() => { this.pendingBytes -= bytes; });
    this.pending = next;
    void next.catch(error => this.fail(error));
    return next;
  }

  private encode(frame: ClaudeFrame): Buffer {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > MAX_BUFFERED_INPUT) throw new Error('The submitted message is too large (maximum 1 MiB)');
    if (this.pendingBytes + bytes.length > MAX_BUFFERED_INPUT) throw new Error('Too much input is waiting for Cantelop');
    return bytes;
  }

  private async send(frame: ClaudeFrame): Promise<void> { await this.sendBytes(this.encode(frame)); }

  private async sendBytes(bytes: Buffer): Promise<void> {
    // Queue all fragments synchronously: no other frame may interleave them.
    const writes: Promise<void>[] = [];
    for (let offset = 0; offset < bytes.length; offset += MAX_INPUT_BYTES) {
      const chunk = bytes.subarray(offset, offset + MAX_INPUT_BYTES);
      writes.push(this.enqueue({ type: 'input', data: chunk.toString('base64') }, chunk.length));
    }
    await Promise.all(writes);
  }

  private control(request: ClaudeFrame): Promise<ClaudeFrame> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error(`Claude timed out handling ${String(request.subtype)}`)); }, this.options.controlTimeoutMs ?? 60_000);
      this.controls.set(id, { resolve, reject, timer });
      void this.send({ type: 'control_request', request_id: id, request }).catch(error => {
        clearTimeout(timer); this.controls.delete(id); reject(error);
      });
    });
  }

  async submit(text: string): Promise<void> {
    if (this.status !== 'ready') throw new Error('Claude is still working; your draft is kept locally');
    if (!text.trim()) return;
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('The prompt is too large (maximum 512 KiB)');
    const bytes = this.encode({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
    const submission = ++this.submission;
    this.setStatus('working');
    try {
      await this.options.beforeSubmit?.();
      this.controller.signal.throwIfAborted();
      if (submission !== this.submission) throw new Error('Prompt submission was interrupted before sending');
      await this.sendBytes(bytes);
    } catch (error) {
      if (!this.controller.signal.aborted && submission === this.submission) this.setStatus('ready');
      throw error;
    }
  }

  async answer(id: string, allow: boolean, answers?: Record<string, string>): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('This permission request is no longer active');
    if (allow) await this.options.beforeSubmit?.();
    if (this.approvals.get(id) !== approval) throw new Error('This permission request is no longer active');
    const bytes = this.encode({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow
      ? { behavior: 'allow', updatedInput: answers ? { ...approval.input, answers } : approval.input }
      : { behavior: 'deny', message: 'The user declined this request.' } } });
    this.approvals.delete(id);
    this.emit('approvals');
    await this.sendBytes(bytes);
  }

  async interrupt(): Promise<void> {
    if (!['working', 'interrupting'].includes(this.status)) return;
    ++this.submission;
    this.setStatus('interrupting');
    await this.control({ subtype: 'interrupt' });
  }

  private updateCommands(value: unknown) {
    if (!Array.isArray(value)) return;
    const previous = new Map(this.commands.map(command => [command.name, command]));
    this.commands = slashCommands(value).map(command => ({ ...command,
      description: command.description || previous.get(command.name)?.description || '',
      argumentHint: command.argumentHint || previous.get(command.name)?.argumentHint || '',
    }));
    this.emit('commands', this.commands);
  }

  private frame(frame: ClaudeFrame) {
    if (frame.type === 'system' && frame.subtype === 'init') this.updateCommands(frame.slash_commands);
    if (frame.type === 'control_response') {
      const response = object(frame.response);
      const id = String(response.request_id);
      const pending = this.controls.get(id);
      if (pending) {
        clearTimeout(pending.timer); this.controls.delete(id);
        if (response.subtype === 'error') pending.reject(new Error(String(response.error ?? 'Claude rejected a control request')));
        else pending.resolve(object(response.response));
      }
    } else if (frame.type === 'control_request') {
      const request = object(frame.request);
      const id = String(frame.request_id);
      if (request.subtype === 'can_use_tool') {
        this.approvals.set(id, { id, tool: String(request.tool_name), input: object(request.input), description: String(request.description ?? request.decision_reason ?? '') });
        this.emit('approvals');
      } else {
        void this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `Juiced does not support ${String(request.subtype)}` } }).catch(error => this.fail(error));
      }
    } else if (frame.type === 'control_cancel_request') {
      this.approvals.delete(String(frame.request_id)); this.emit('approvals');
    } else if (frame.type === 'result') {
      if (this.status === 'interrupting') frame = { ...frame, juiced_interrupted: true };
      this.approvals.clear(); this.emit('approvals'); this.setStatus('ready');
    }
    this.emit('frame', frame);
  }

  private async read(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        for await (const event of this.session.stream({ ...(this.cursor ? { after: this.cursor } : {}), signal: this.controller.signal })) {
          const data = event.data;
          if (data.type === 'output') {
            const bytes = Buffer.from(data.data, 'base64');
            if (data.channel === 'stderr') {
              this.diagnostic = (this.diagnostic + bytes.toString()).slice(-8000);
              this.emit('diagnostic', bytes.toString());
            } else {
              for (const frame of this.decoder.push(bytes)) this.frame(frame);
            }
          } else if (data.type === 'error') throw new RemoteProcessError(data.message);
          else if (data.type === 'exit') {
            this.decoder.finish();
            throw new RemoteProcessError(`Remote Claude exited (${data.code})${this.diagnostic ? `: ${this.diagnostic.trim()}` : ''}`);
          }
          this.cursor = event.cursor;
          failures = 0;
        }
        throw new Error('The Claude output stream ended unexpectedly');
      } catch (error) {
        if (this.controller.signal.aborted) return;
        const remote = error as { status?: number; name?: string; message?: string };
        const retryable = remote.status !== undefined ? remote.status === 0 || remote.status >= 500 : remote.name === 'AbortError' || /stream|fetch|network|socket|terminated|connection/i.test(remote.message ?? '');
        if (error instanceof RemoteProcessError || !retryable || ++failures > 3) throw error;
        this.debug('stream.retry', { attempt: failures, name: remote.name });
        this.emit('reconnecting', failures);
        await delay(250 * 2 ** (failures - 1), undefined, { signal: this.controller.signal });
      }
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.rejectControls(new Error('Juiced disconnected'));
      this.approvals.clear();
      const timeout = new AbortController();
      try {
        if (this.started) await Promise.race([this.session.stop(), delay(this.options.stopTimeoutMs ?? 10_000, undefined, { signal: timeout.signal, ref: false }).then(() => { throw new Error('Cantelop session cleanup timed out; its lease expires within 90 seconds'); })]);
      } finally { timeout.abort(); }
      await this.reader?.catch(() => {});
      this.setStatus('closed');
    })();
  }
}
