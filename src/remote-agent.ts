import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionEvent, SessionEventCursor, SessionRef } from '@cantelop/sdk';
import { MAX_PROMPT_BYTES, type AgentJournalEntry, type TerminalCommand, type TerminalEvent, type TerminalReply } from './protocol.js';
import { ClaudeDecoder, headlessArguments, modelOptions, object, slashCommands, type Approval, type ApprovalOptions, type ClaudeFrame, type MenuChange, type MenuQuery, type ModelOption, type SlashCommand } from './agent-protocol.js';
import type { SavedSettings } from './settings.js';
import { backoffMs, isCursorExpired, isTransient, isViewMissing, linkSignal, withTimeout } from './transport.js';
import { PublicationBroker, type LocalPublish } from './agent/publications.js';
import { processChanged, RemoteProcessError, TransportQueue } from './agent/transport-queue.js';

export type AgentSession = Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'id' | 'request' | 'dispatch' | 'stream' | 'stop'> & Partial<Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'view'>>;
export type AgentStatus = 'connecting' | 'ready' | 'working' | 'configuring' | 'interrupting' | 'closed' | 'failed';
type Control = { resolve(value: ClaudeFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
/** Older Claude binaries reject newer menu queries by subtype. */
export const unsupportedControl = (error: unknown) => /Unsupported control request subtype/u.test((error as Error).message);

/** A headless Claude process on Cantelop. Keyboard editing never enters this class. */
export class RemoteAgent extends EventEmitter {
  status: AgentStatus = 'connecting';
  readonly approvals = new Map<string, Approval>();
  commands: SlashCommand[] = [];
  models: ModelOption[] = [];
  model = 'default';
  /** Only public UI metadata; account credentials are never included. */
  info: ClaudeFrame = {};
  readonly tasks = new Map<string, ClaudeFrame>();
  private controller = new AbortController();
  private decoder = new ClaudeDecoder();
  private controls = new Map<string, Control>();
  private transport: TransportQueue;
  private publications: PublicationBroker;
  private submission = 0;
  private reader: Promise<void> | undefined;
  private durable = false;
  private epoch = '';
  private sequence = 0;
  private userChunks = new Map<string, Buffer[]>();
  private sleeping = false;
  private remoteState = 'ready';
  private nativeInitialization: ClaudeFrame | undefined;
  private sessionPermissionMode: { mode: string; epoch: string } | undefined;
  private submitting = false;
  private initializing = false;
  private startCommand?: Extract<TerminalCommand, { type: 'start' }>;
  private reopening: Promise<void> | undefined;
  private caughtUp: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private started = false;
  private cursor: SessionEventCursor | undefined;
  private diagnostic = '';
  private unsupportedQueries = new Set<string>();
  private settingsSnapshot: { value: ClaudeFrame; expires: number } | undefined;
  private settingsRevision = 0;

  constructor(readonly session: AgentSession, private options: { controlTimeoutMs?: number; stopTimeoutMs?: number; directoryName?: string; git?: { binding: string; relativeDirectory: string }; localPublish?: LocalPublish } = {}) {
    super();
    const signal = this.controller.signal;
    this.transport = new TransportQueue(session, signal, { emit: (event, ...args) => this.emit(event, ...args), debug: (event, detail) => this.debug(event, detail), fail: error => this.fail(error) });
    this.publications = new PublicationBroker({ approvals: this.approvals, emit: (event, ...args) => this.emit(event, ...args), request: command => this.request(command), signal, localPublish: options.localPublish });
  }

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
  private invalidateSettings() { this.settingsSnapshot = undefined; this.settingsRevision++; }

  async start(argv: string[] = []): Promise<void> {
    if (this.started) throw new Error('The agent has already started');
    this.started = true;
    this.initializing = true;
    let requestedModel: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--model' && argv[i + 1]) requestedModel = argv[++i]!;
      else if (argv[i]!.startsWith('--model=')) requestedModel = argv[i]!.slice('--model='.length);
    }
    try {
      this.startCommand = { type: 'start', durable: true, argv: headlessArguments(argv), tty: false, columns: 120, rows: 36, term: 'dumb', ...(this.options.directoryName ? { directoryName: this.options.directoryName } : {}), ...(this.options.git ? { git: this.options.git } : {}), ...(this.options.localPublish ? { localPublish: this.options.localPublish.head } : {}) };
      const reply = await this.request(this.startCommand);
      if (reply?.ok !== true) throw new Error('Cantelop could not start Claude');
      this.durable = Boolean(reply.agent);
      if (reply.agent) { this.epoch = reply.agent.epoch; this.nativeInitialization = reply.agent.initialized; }
      const caughtUp = new Promise<void>(resolve => { this.caughtUp = resolve; });
      this.reader = this.read();
      void this.reader.catch(error => this.fail(error));
      if (this.durable) await Promise.race([caughtUp, this.reader]);
      if (this.sleeping) await this.ensureProcess();
      this.initialize(this.nativeInitialization ?? await this.control({ subtype: 'initialize', hooks: null }));
      // initialize does not report the model loaded from settings.json.
      const settings = await this.control({ subtype: 'get_settings' });
      if (this.remoteState === 'ready') this.settingsSnapshot = { value: settings, expires: Date.now() + 30_000 };
      // Keep the chosen alias when available; applied.model is a resolved ID.
      const model = requestedModel ?? object(settings.effective).model ?? object(settings.applied).model;
      if (typeof model === 'string' && model) this.model = model;
      this.emit('models', this.models);
      this.emit('model', this.model);
      this.initializing = false;
      this.setStatus(this.remoteState === 'working' ? 'working' : 'ready');
    } catch (error) { this.initializing = false; this.fail(error); throw error; }
  }

  private initialize(frame: ClaudeFrame) {
    this.invalidateSettings();
    this.unsupportedQueries.clear();
    this.nativeInitialization = frame;
    this.updateCommands(frame.commands); this.models = modelOptions(frame.models);
    for (const key of ['agents', 'output_style', 'available_output_styles', 'current_permission_mode', 'fast_mode_state', 'fast_mode_disabled_reason']) {
      if (frame[key] !== undefined) this.info[key] = frame[key];
    }
    this.emit('models', this.models);
  }

  private request(command: TerminalCommand): Promise<TerminalReply> { return this.transport.request(command); }
  private encode(frame: ClaudeFrame): Buffer { return this.transport.encode(frame); }
  private async send(frame: ClaudeFrame, retryProcessChange = false): Promise<void> { await this.sendBytes(this.encode(frame), retryProcessChange); }
  private sendBytes(bytes: Buffer, retryProcessChange = false): Promise<void> {
    return this.transport.sendBytes(bytes, this.durable ? { epoch: this.epoch } : undefined, retryProcessChange);
  }

  private async control(request: ClaudeFrame, retryProcessChange = false): Promise<ClaudeFrame> {
    if (this.sleeping) await this.ensureProcess();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error(`Claude timed out handling ${String(request.subtype)}`)); }, this.options.controlTimeoutMs ?? 60_000);
      this.controls.set(id, { resolve, reject, timer });
      void this.send({ type: 'control_request', request_id: id, request }, retryProcessChange).catch(error => {
        clearTimeout(timer); this.controls.delete(id); reject(error);
      });
    });
  }

  private ensureProcess(force = false): Promise<void> {
    if (!this.durable || !this.sleeping && !force) return Promise.resolve();
    return this.reopening ??= (async () => {
      const reply = await this.request(this.startCommand!);
      if (!reply.ok || !reply.agent) throw new Error('Cantelop could not restore Claude');
      if (this.epoch !== reply.agent.epoch) this.nativeInitialization = undefined;
      this.epoch = reply.agent.epoch; this.sleeping = false;
      if (!this.nativeInitialization) this.initialize(reply.agent.initialized ?? await this.control({ subtype: 'initialize', hooks: null }));
      // Idle restarts use the launch defaults. Restore the acknowledged session
      // choice before any input, retaining it for another attempt if refused.
      const permission = this.sessionPermissionMode;
      if (permission && permission.epoch !== this.epoch) {
        await this.control({ subtype: 'set_permission_mode', mode: permission.mode });
        this.sessionPermissionMode = { mode: permission.mode, epoch: this.epoch };
        this.info.current_permission_mode = permission.mode;
      }
    })().finally(() => { this.reopening = undefined; });
  }

  /** Reopening the picker refreshes Claude's catalog without submitting a turn. */
  async refreshModels(): Promise<ModelOption[]> {
    try {
      const response = await this.query({ subtype: 'list_models' });
      if (!Array.isArray(response.models)) throw new Error('Claude did not provide a model list. Use /model <name> to choose a model.');
      this.models = modelOptions(response.models);
      this.emit('models', this.models);
    } catch (error) {
      // Older binaries only expose the initialization catalog.
      if (!unsupportedControl(error)) throw error;
    }
    return this.models;
  }

  async setModel(model: string): Promise<void> {
    if (this.status !== 'ready') throw new Error('Wait for Claude to finish before switching models');
    if (!model || /\s|[\x00-\x1f\x7f-\x9f]/u.test(model)) throw new Error('Specify one model alias or full model ID');
    this.invalidateSettings();
    this.setStatus('configuring');
    try {
      await this.ensureProcess(true);
      await this.control({ subtype: 'set_model', model });
      this.model = model;
      this.emit('model', model);
      await this.persist({ model });
    } finally {
      if (!this.controller.signal.aborted) this.setStatus('ready');
    }
  }

  private async persist(settings: SavedSettings): Promise<void> {
    try {
      const reply = await withTimeout(this.controller.signal, 20_000, signal => this.session.request({ type: 'save-settings', settings }, { timeoutMs: 15_000, signal }));
      if (!reply?.ok) throw new Error(reply && 'error' in reply ? reply.error : 'The runtime did not confirm the save');
    } catch (error) {
      throw new Error(`Changed for this session, but could not save for future sessions: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /** Menu reads never occupy the prompt queue or submit a user/model turn. */
  async query(request: MenuQuery, options: { cached?: boolean } = {}): Promise<ClaudeFrame> {
    if (!['ready', 'working', 'interrupting', 'configuring'].includes(this.status)) throw new Error('Claude is not connected yet');
    if (options.cached && request.subtype === 'get_settings' && this.status === 'ready' && this.settingsSnapshot && this.settingsSnapshot.expires > Date.now()) return this.settingsSnapshot.value;
    try {
      await this.ensureProcess();
      if (this.unsupportedQueries.has(request.subtype)) throw new Error(`Unsupported control request subtype: ${request.subtype}`);
      let revision = this.settingsRevision;
      let response: ClaudeFrame;
      try { response = await this.control(request, true); }
      catch (error) {
        if (!processChanged(error)) throw error;
        // The runtime rejected this input before delivery. Only reads take this
        // shortcut; writes still check the process before their first attempt.
        await this.ensureProcess(true);
        revision = this.settingsRevision;
        response = await this.control(request, true);
      }
      if (request.subtype === 'get_settings' && revision === this.settingsRevision && this.status === 'ready') this.settingsSnapshot = { value: response, expires: Date.now() + 30_000 };
      return response;
    }
    catch (error) {
      if (unsupportedControl(error)) this.unsupportedQueries.add(request.subtype);
      throw error;
    }
  }

  /** `persist: false` applies a permission mode to this session only, like Claude Code's Shift+Tab. */
  async configure(request: MenuChange, options: { persist?: boolean } = {}): Promise<ClaudeFrame> {
    if (request.subtype === 'stop_task' && ['working', 'interrupting'].includes(this.status)) return this.control(request);
    if (this.status !== 'ready') throw new Error('Wait for Claude to finish before changing settings');
    this.invalidateSettings();
    this.setStatus('configuring');
    try {
      await this.ensureProcess(true);
      const response = await this.control(request);
      if (request.subtype === 'set_permission_mode') {
        this.sessionPermissionMode = { mode: request.mode, epoch: this.epoch };
        this.info.current_permission_mode = request.mode;
        if (options.persist !== false) await this.persist({ permissionMode: request.mode });
      }
      if (request.subtype === 'apply_flag_settings') {
        if (typeof request.settings.outputStyle === 'string') this.info.output_style = request.settings.outputStyle;
        if (typeof request.settings.fastMode === 'boolean') this.info.fast_mode_state = request.settings.fastMode ? 'on' : 'off';
        const saved: SavedSettings = {};
        if (typeof request.settings.effortLevel === 'string') saved.effortLevel = request.settings.effortLevel;
        if (typeof request.settings.outputStyle === 'string') saved.outputStyle = request.settings.outputStyle;
        if (typeof request.settings.fastMode === 'boolean') saved.fastMode = request.settings.fastMode;
        if (Object.keys(saved).length) await this.persist(saved);
      }
      if (request.subtype === 'reload_plugins') {
        this.updateCommands(response.commands);
        if (Array.isArray(response.agents)) this.info.agents = response.agents;
        if (Array.isArray(response.plugins)) this.info.plugins = response.plugins;
      }
      if (request.subtype === 'reload_skills') {
        // The response contains skills only, not the complete command catalog.
        this.updateCommands([...this.commands, ...slashCommands(response.skills)]);
      }
      return response;
    } finally { if (!this.controller.signal.aborted) this.setStatus('ready'); }
  }

  async submit(text: string): Promise<void> {
    if (this.status !== 'ready' || this.submitting) throw new Error('Claude is still working; your draft is kept locally');
    if (!text.trim()) return;
    if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) throw new Error('The prompt is too large (maximum 512 KiB)');
    const bytes = this.encode({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
    const submission = ++this.submission;
    this.invalidateSettings();
    this.submitting = true;
    this.setStatus('working');
    try {
      await this.ensureProcess(true);
      this.controller.signal.throwIfAborted();
      if (submission !== this.submission) throw new Error('Prompt submission was interrupted before sending');
      await this.sendBytes(bytes);
    } catch (error) {
      if (!this.controller.signal.aborted && submission === this.submission) this.setStatus('ready');
      throw error;
    } finally { this.submitting = false; }
  }

  async answer(id: string, allow: boolean, answers?: Record<string, string>, options: ApprovalOptions = {}): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('This permission request is no longer active');
    if (approval.local) return this.publications.answer(id, allow);
    const bytes = this.encode({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow
      ? { behavior: 'allow', updatedInput: answers ? { ...approval.input, answers } : approval.input, ...(options.suggestions?.length ? { updatedPermissions: options.suggestions } : {}) }
      : { behavior: 'deny', message: options.message ? `The user declined this request and said: ${options.message}` : 'The user declined this request.' } } });
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
    if (frame.type === 'system' && frame.subtype === 'init') {
      this.invalidateSettings();
      this.updateCommands(frame.slash_commands);
      if (Array.isArray(frame.plugins)) this.info.plugins = frame.plugins;
      if (typeof frame.permissionMode === 'string') {
        this.info.current_permission_mode = frame.permissionMode;
        // Shift+Tab offers bypass mode only to sessions launched with it.
        this.info.launch_permission_mode ??= frame.permissionMode;
      }
    }
    // Claude reports its own mode changes, such as leaving plan mode, in status frames.
    if (frame.type === 'system' && frame.subtype === 'status' && typeof frame.permissionMode === 'string') {
      this.info.current_permission_mode = frame.permissionMode;
      if (this.sessionPermissionMode?.epoch === this.epoch) this.sessionPermissionMode.mode = frame.permissionMode;
    }
    if (frame.type === 'system' && typeof frame.task_id === 'string') {
      if (frame.subtype === 'task_started') this.tasks.set(frame.task_id, { ...frame, status: 'running' });
      else if (frame.subtype === 'task_notification') this.tasks.set(frame.task_id, { ...this.tasks.get(frame.task_id), ...frame });
      else if (frame.subtype === 'task_progress') this.tasks.set(frame.task_id, { status: 'running', ...this.tasks.get(frame.task_id), ...frame });
      else if (frame.subtype === 'task_updated') this.tasks.set(frame.task_id, { ...this.tasks.get(frame.task_id), ...object(frame.patch), task_id: frame.task_id });
    }
    if (frame.type === 'system' && frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
      this.tasks.clear();
      for (const raw of frame.tasks) { const task = object(raw); if (typeof task.task_id === 'string') this.tasks.set(task.task_id, { ...task, status: 'running' }); }
    }
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
        const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions.map(object) : [];
        this.approvals.set(id, { id, tool: String(request.tool_name), input: object(request.input), description: String(request.description ?? request.decision_reason ?? ''), ...(suggestions.length ? { suggestions } : {}) });
        this.emit('approvals');
      } else {
        void this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `Juiced does not support ${String(request.subtype)}` } }).catch(error => this.fail(error));
      }
    } else if (frame.type === 'control_cancel_request') {
      this.approvals.delete(String(frame.request_id)); this.emit('approvals');
    } else if (frame.type === 'result') {
      this.invalidateSettings();
      if (this.status === 'interrupting') frame = { ...frame, juiced_interrupted: true };
      this.approvals.clear(); this.emit('approvals'); if (!this.initializing) this.setStatus('ready');
    }
    this.emit('frame', frame);
  }

  /** Claude's stderr is kept (bounded) for the exit message and shown as a diagnostic. */
  private stderr(bytes: Buffer) {
    this.diagnostic = (this.diagnostic + bytes.toString()).slice(-8000);
    this.emit('diagnostic', bytes.toString());
  }

  private journalEntry(entry: AgentJournalEntry) {
    if (entry.sequence <= this.sequence) return;
    if (entry.sequence !== this.sequence + 1) throw new Error('Agent history contains a gap');
    const event = entry.event;
    if (event.type === 'bytes') {
      const bytes = Buffer.from(event.data, 'base64');
      if (event.channel === 'stderr') this.stderr(bytes);
      else for (const frame of this.decoder.push(bytes)) this.frame(frame);
    } else if (event.type === 'user') {
      const chunks = this.userChunks.get(event.id) ?? [];
      chunks.push(Buffer.from(event.data, 'base64'));
      if (event.final) { this.userChunks.delete(event.id); this.frame({ type: 'juiced_user', text: Buffer.concat(chunks).toString() }); }
      else this.userChunks.set(event.id, chunks);
    } else if (event.type === 'approval-answer') {
      this.approvals.delete(event.id); this.emit('approvals');
    } else if (event.type === 'local-publish') {
      this.publications.offer(event.publication);
    } else if (event.type === 'local-upload') {
      this.publications.offer(event.request);
    } else if (event.type === 'local-publish-done') {
      this.publications.done(event.id);
    } else if (event.type === 'reset') {
      this.publications.reset();
      this.invalidateSettings();
      this.unsupportedQueries.clear();
      this.decoder = new ClaudeDecoder(); this.approvals.clear(); this.emit('approvals');
      this.userChunks.clear();
      this.sleeping = !event.epoch || event.epoch !== this.epoch;
      if (event.interrupted) this.frame({ type: 'result', juiced_interrupted: true, result: 'The remote process stopped. Saved output was recovered; the interrupted prompt was not resubmitted.' });
    } else if (event.type === 'state') {
      if (event.state === 'sleeping' || event.state === 'working') this.invalidateSettings();
      this.remoteState = event.state;
      this.sleeping = event.state === 'sleeping';
      if (!this.initializing) this.setStatus(event.state === 'working' ? 'working' : 'ready');
    }
    this.sequence = entry.sequence;
  }

  private async readDurable(): Promise<void> {
    let failures = 0, recover = true;
    while (!this.controller.signal.aborted) {
      let watchdog: AbortSignal | undefined;
      let replayId: string | undefined;
      let unseen: AgentJournalEntry | undefined;
      let events: AsyncIterator<SessionEvent<TerminalEvent>> | undefined;
      let replayStarted = 0, replayChunks = 0, replayEntries = 0;
      const connectedAt = performance.now();
      let firstEvent = true, caught = false;
      const subscription = new AbortController();
      // Every watchdog cycle reconnects; never accumulate dependents on the agent signal.
      const connection = linkSignal(this.controller.signal);
      try {
        const view = await this.session.view?.({ signal: this.controller.signal }).catch(error => {
          if (isViewMissing(error)) return undefined;
          throw error;
        });
        this.debug('agent.view', { elapsedMs: performance.now() - connectedAt, sequence: Number(object(view?.state).agentSequence) || 0 });
        // A read watchdog also recovers half-open connections after laptop sleep.
        // View and stream reads do not activate compute or extend a work lease.
        watchdog = AbortSignal.timeout(30_000);
        const signal = AbortSignal.any([connection.signal, watchdog, subscription.signal]);
        const replay = () => {
          const id = replayId = randomUUID();
          replayStarted = performance.now(); replayChunks = 0; replayEntries = 0;
          this.debug('agent.replay.start', { after: this.sequence });
          const command: TerminalCommand = { type: 'agent-replay', after: this.sequence, stream: id };
          // Read the same subscription throughout recovery. One command streams all
          // pages; its acceptance never blocks consuming output or durable handoffs.
          void this.session.dispatch(command, { signal }).catch(error => {
            if (replayId === id) subscription.abort(error);
          });
        };
        const caughtUp = () => {
          if (!caught) { this.debug('agent.caught-up', { elapsedMs: performance.now() - connectedAt, sequence: this.sequence }); caught = true; }
          if (failures) this.emit('reconnected');
          failures = 0;
          this.caughtUp?.(); this.caughtUp = undefined;
        };
        const boundary = view?.cursor;
        const after = this.cursor && (!boundary || this.cursor.streamId === boundary.streamId && this.cursor.sequence > boundary.sequence) ? this.cursor : boundary;
        events = this.session.stream({ ...(after ? { after } : {}), signal })[Symbol.asyncIterator]();
        // Issue the subscription before starting a producer that can exceed retention.
        const first = events.next();
        if (recover || Number(object(view?.state).agentSequence) > this.sequence) replay();
        else caughtUp();
        recover = false;
        for (let next = await first; !next.done; next = await events.next()) {
          const event = next.value;
          if (firstEvent) { this.debug('agent.stream.first-event', { elapsedMs: performance.now() - connectedAt }); firstEvent = false; }
          if (event.data.type === 'agent-output') {
            if (event.data.sequence > this.sequence + 1) {
              if (!unseen || event.data.sequence > unseen.sequence) unseen = event.data;
              if (!replayId) replay();
            } else this.journalEntry(event.data);
          } else if (event.data.type === 'agent-replay' && event.data.id === replayId) {
            if (!replayChunks) this.debug('agent.replay.first-chunk', { elapsedMs: performance.now() - replayStarted });
            replayChunks++; replayEntries += event.data.entries.length;
            for (const entry of event.data.entries) this.journalEntry(entry);
          } else if (event.data.type === 'agent-replay-end' && event.data.id === replayId) {
            if (event.data.error) throw new RemoteProcessError(event.data.error);
            if (this.sequence < event.data.latest) throw new Error('The agent history stream is incomplete');
            this.debug('agent.replay.complete', { elapsedMs: performance.now() - replayStarted, chunks: replayChunks, entries: replayEntries });
            replayId = undefined;
            if (unseen && unseen.sequence === this.sequence + 1) this.journalEntry(unseen);
            if (unseen && unseen.sequence > this.sequence) replay();
            else { unseen = undefined; caughtUp(); }
          } else if (event.data.type === 'error') throw new RemoteProcessError(event.data.message);
          this.cursor = event.cursor;
          if (!replayId) caughtUp();
        }
        throw new Error('The Claude output stream ended unexpectedly');
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (watchdog?.aborted) { recover = Boolean(replayId) || this.remoteState === 'working'; continue; }
        if (subscription.signal.aborted) error = subscription.signal.reason;
        this.invalidateSettings();
        const expired = isCursorExpired(error);
        if (expired) this.cursor = undefined;
        if (error instanceof RemoteProcessError || !expired && !isTransient(error)) throw error;
        recover = true;
        this.emit('reconnecting', ++failures);
        await delay(backoffMs(failures - 1), undefined, { signal: this.controller.signal });
      } finally { subscription.abort(); connection.dispose(); await events?.return?.(); }
    }
  }

  private async read(): Promise<void> {
    if (this.durable) return this.readDurable();
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        for await (const event of this.session.stream({ ...(this.cursor ? { after: this.cursor } : {}), signal: this.controller.signal })) {
          const data = event.data;
          if (data.type === 'output') {
            const bytes = Buffer.from(data.data, 'base64');
            if (data.channel === 'stderr') this.stderr(bytes);
            else for (const frame of this.decoder.push(bytes)) this.frame(frame);
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
        if (error instanceof RemoteProcessError || !isTransient(error)) throw error;
        ++failures;
        this.debug('stream.retry', { attempt: failures, name: (error as Error)?.name });
        this.emit('reconnecting', failures);
        await delay(backoffMs(failures - 1), undefined, { signal: this.controller.signal });
      }
    }
  }

  close(stop = true): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort();
      this.rejectControls(new Error('Juiced disconnected'));
      this.approvals.clear();
      const timeout = new AbortController();
      try {
        if (this.started && stop) await Promise.race([this.session.stop(), delay(this.options.stopTimeoutMs ?? 10_000, undefined, { signal: timeout.signal, ref: false }).then(() => { throw new Error('Cantelop session cleanup timed out'); })]);
      } finally { timeout.abort(); }
      await this.reader?.catch(() => {});
      await this.publications.settled();
      this.setStatus('closed');
    })();
  }
}
