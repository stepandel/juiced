import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionEvent, SessionEventCursor, SessionRef } from '@cantelop/sdk';
import { MAX_BUFFERED_INPUT, MAX_INPUT_BYTES, type AgentJournalEntry, type TerminalCommand, type TerminalEvent, type TerminalReply } from './protocol.js';
import { ClaudeDecoder, headlessArguments, modelOptions, object, slashCommands, type Approval, type ApprovalOptions, type ClaudeFrame, type ModelOption, type SlashCommand } from './agent-protocol.js';
import type { SavedSettings } from './settings.js';
import { validateExportManifest, validTransferId } from './git-protocol.js';
import type { Publication, PublishResult } from './publish-protocol.js';
import { backoffMs, isCursorExpired, isTransient, isViewMissing, linkSignal, messageId, withTimeout } from './transport.js';

export type AgentSession = Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'id' | 'request' | 'dispatch' | 'stream' | 'stop'> & Partial<Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'view'>>;
export type AgentStatus = 'connecting' | 'ready' | 'working' | 'configuring' | 'interrupting' | 'closed' | 'failed';
type Control = { resolve(value: ClaudeFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export type MenuQuery = { subtype: 'get_settings' | 'mcp_status' | 'get_session_cost' | 'list_models' | 'get_hooks_listing' | 'list_permission_rules' }
  | { subtype: 'get_context_usage'; detail: 'summary' }
  | { subtype: 'get_usage'; skip_behaviors: true }
  | { subtype: 'read_file'; path: string; max_bytes: number }
  | { subtype: 'get_task_output'; task_id: string };
export type MenuChange = { subtype: 'apply_flag_settings'; settings: ClaudeFrame }
  | { subtype: 'set_permission_mode'; mode: string }
  | { subtype: 'mcp_reconnect'; serverName: string }
  | { subtype: 'mcp_toggle'; serverName: string; enabled: boolean }
  | { subtype: 'reload_plugins' | 'reload_skills' }
  | { subtype: 'rename_session'; title: string }
  | { subtype: 'stop_task'; task_id: string };
class RemoteProcessError extends Error {}
const processChanged = (error: unknown) => error instanceof RemoteProcessError && error.message === 'The Claude process changed. Reconnect before submitting input.';
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
  private pending = Promise.resolve();
  private pendingBytes = 0;
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
  private publicationClient = randomUUID();
  private publications = new Map<string, Publication>();
  private finishedPublications = new Set<string>();
  private publicationWork = new Set<Promise<unknown>>();
  private publicationControllers = new Map<string, AbortController>();

  constructor(readonly session: AgentSession, private options: { controlTimeoutMs?: number; stopTimeoutMs?: number; directoryName?: string; git?: { binding: string; relativeDirectory: string }; localPublish?: { head: string; apply(publication: Publication, signal: AbortSignal): Promise<PublishResult> } } = {}) { super(); }

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

  private async request(command: TerminalCommand, id = messageId()): Promise<TerminalReply> {
    for (let failures = 0; ; failures++) {
      this.controller.signal.throwIfAborted();
      try {
        const reply = await withTimeout(this.controller.signal, 125_000, signal => this.session.request(command, { id, timeoutMs: 120_000, signal }));
        if (!reply.ok) throw new RemoteProcessError(reply.error);
        if (failures) this.emit('reconnected');
        return reply;
      } catch (error) {
        if (this.controller.signal.aborted) throw this.controller.signal.reason;
        if (!isTransient(error) || error instanceof RemoteProcessError) throw error;
        this.emit('reconnecting', failures + 1);
        await delay(backoffMs(failures), undefined, { signal: this.controller.signal });
      }
    }
  }

  private enqueue(command: TerminalCommand, bytes: number, retryProcessChange = false): Promise<void> {
    if (this.pendingBytes + bytes > MAX_BUFFERED_INPUT) return Promise.reject(new Error('Too much input is waiting for Cantelop'));
    this.pendingBytes += bytes;
    const next = this.pending.then(async () => {
      this.controller.signal.throwIfAborted();
      const start = Date.now();
      this.debug('control.dispatch', { type: command.type });
      // Serialize durable handoff receipts and legacy dispatch acceptance;
      // keyboard editing remains independent of this queue.
      if (command.type === 'agent-input') await this.request(command, messageId(command.id));
      else await withTimeout(this.controller.signal, 35_000, signal => this.session.dispatch(command, { signal }));
      this.debug('control.accepted', { type: command.type, elapsedMs: Date.now() - start });
    }).finally(() => { this.pendingBytes -= bytes; });
    this.pending = next.catch(() => {});
    void next.catch(error => {
      // A menu read can reopen and retry an explicitly rejected stale epoch.
      // Ambiguous delivery failures and mutations retain their normal handling.
      if (!retryProcessChange || !processChanged(error)) this.fail(error);
    });
    return next;
  }

  private encode(frame: ClaudeFrame): Buffer {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > MAX_BUFFERED_INPUT) throw new Error('The submitted message is too large (maximum 1 MiB)');
    if (this.pendingBytes + bytes.length > MAX_BUFFERED_INPUT) throw new Error('Too much input is waiting for Cantelop');
    return bytes;
  }

  private async send(frame: ClaudeFrame, retryProcessChange = false): Promise<void> { await this.sendBytes(this.encode(frame), retryProcessChange); }

  private async sendBytes(bytes: Buffer, retryProcessChange = false): Promise<void> {
    if (this.durable) {
      if (bytes.length > 768 * 1024) throw new Error('The submitted message is too large');
      await this.enqueue({ type: 'agent-input', id: randomUUID(), epoch: this.epoch, frame: JSON.parse(bytes.toString()) as ClaudeFrame }, bytes.length, retryProcessChange);
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
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('The prompt is too large (maximum 512 KiB)');
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
    if (approval.local) {
      const work = this.answerPublication(id, allow);
      this.publicationWork.add(work);
      try { await work; } finally { this.publicationWork.delete(work); }
      return;
    }
    const bytes = this.encode({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow
      ? { behavior: 'allow', updatedInput: answers ? { ...approval.input, answers } : approval.input, ...(options.suggestions?.length ? { updatedPermissions: options.suggestions } : {}) }
      : { behavior: 'deny', message: options.message ? `The user declined this request and said: ${options.message}` : 'The user declined this request.' } } });
    this.approvals.delete(id);
    this.emit('approvals');
    await this.sendBytes(bytes);
  }

  private offerPublication(publication: Publication) {
    if (!this.options.localPublish || this.publications.has(publication.id) || this.finishedPublications.has(publication.id) || publication.expiresAt <= Date.now()) return;
    if (!validTransferId(publication.id) || !['commits', 'snapshot'].includes(publication.kind) || typeof publication.summary !== 'string' || publication.summary.length > 2000 ||
        !Number.isSafeInteger(publication.expiresAt) || !Number.isSafeInteger(publication.fileCount) || publication.fileCount < 0 || !Array.isArray(publication.paths) || publication.paths.length > 20 || publication.paths.some(path => typeof path !== 'string' || path.length > 200)) throw new Error('Invalid publication offer');
    validateExportManifest(publication.manifest);
    this.publications.set(publication.id, publication);
    // Replayed offers must still be pending in the live runtime. A journal
    // entry from a completed or lost native process never authorizes a write.
    const work = this.request({ type: 'publish-status', id: publication.id }).then(() => {
      if (this.finishedPublications.has(publication.id) || publication.expiresAt <= Date.now() || this.controller.signal.aborted) return;
      const snapshot = publication.manifest.snapshot;
      this.approvals.set(publication.id, { id: publication.id, local: true, tool: publication.kind === 'commits' ? 'Publish commits' : 'Publish snapshot', description: publication.summary,
        input: { commit: publication.manifest.head, ...(snapshot ? { baseline: snapshot.baseHead, baselineTree: snapshot.baseTree, snapshotTree: snapshot.tree } : {}), files: publication.fileCount, paths: publication.paths, ...(publication.fileCount > publication.paths.length ? { preview: 'First 20 paths shown' } : {}) } });
      this.emit('approvals');
    }).catch(() => { this.publications.delete(publication.id); });
    this.publicationWork.add(work);
    void work.finally(() => this.publicationWork.delete(work));
  }

  private async answerPublication(id: string, allow: boolean) {
    const publication = this.publications.get(id);
    if (!publication || this.finishedPublications.has(id)) throw new Error('This publication is no longer active.');
    this.finishedPublications.add(id);
    this.approvals.delete(id); this.emit('approvals');
    const controller = new AbortController();
    this.publicationControllers.set(id, controller);
    try {
      await this.request({ type: 'publish-claim', id, client: this.publicationClient });
      let result: PublishResult = { status: 'declined', message: 'The user declined local application. Local files were not changed.' };
      if (allow) {
        try {
          result = await withTimeout(this.controller.signal, Math.max(1, publication.expiresAt - Date.now()), async expiry => {
            const signal = AbortSignal.any([expiry, controller.signal]);
            signal.throwIfAborted();
            return this.options.localPublish!.apply(publication, signal);
          });
        } catch (error) { result = { status: 'conflict', message: error instanceof Error ? error.message : 'Local application failed. Check the local checkout before retrying.' }; }
      }
      this.emit('frame', { type: 'juiced_publish', id, message: result.message, failed: !['applied', 'already-applied'].includes(result.status) });
      await this.request({ type: 'publish-result', id, client: this.publicationClient, result });
    } finally { this.publications.delete(id); this.publicationControllers.delete(id); }
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

  private journalEntry(entry: AgentJournalEntry) {
    if (entry.sequence <= this.sequence) return;
    if (entry.sequence !== this.sequence + 1) throw new Error('Agent history contains a gap');
    const event = entry.event;
    if (event.type === 'bytes') {
      const bytes = Buffer.from(event.data, 'base64');
      if (event.channel === 'stderr') {
        this.diagnostic = (this.diagnostic + bytes.toString()).slice(-8000);
        this.emit('diagnostic', bytes.toString());
      } else for (const frame of this.decoder.push(bytes)) this.frame(frame);
    } else if (event.type === 'user') {
      const chunks = this.userChunks.get(event.id) ?? [];
      chunks.push(Buffer.from(event.data, 'base64'));
      if (event.final) { this.userChunks.delete(event.id); this.frame({ type: 'juiced_user', text: Buffer.concat(chunks).toString() }); }
      else this.userChunks.set(event.id, chunks);
    } else if (event.type === 'approval-answer') {
      this.approvals.delete(event.id); this.emit('approvals');
    } else if (event.type === 'local-publish') {
      this.offerPublication(event.publication);
    } else if (event.type === 'local-publish-done') {
      this.publicationControllers.get(event.id)?.abort(new Error('The remote publication ended. Check the local checkout.'));
      this.finishedPublications.add(event.id); this.publications.delete(event.id);
      this.approvals.delete(event.id); this.emit('approvals');
    } else if (event.type === 'reset') {
      for (const [id, controller] of this.publicationControllers) { this.finishedPublications.add(id); controller.abort(new Error('The remote Claude process changed.')); }
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
      await Promise.allSettled(this.publicationWork);
      this.setStatus('closed');
    })();
  }
}
