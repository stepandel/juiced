import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { SessionEvent } from '@cantelop/sdk';
import { ClaudeDecoder, headlessArguments, modelOptions, object, slashCommands, useLocalTui, type ClaudeFrame } from '../src/agent-protocol.js';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import type { TerminalCommand, TerminalEvent } from '../src/protocol.js';
import { until as poll } from './fixtures/wait.js';

const until = (check: () => boolean) => poll(check, 2000);

function fixture(options: ConstructorParameters<typeof RemoteAgent>[1] = {}, initialization: ClaudeFrame = {}, modelResponse: 'success' | 'error' | 'pending' = 'success', responses: Record<string, ClaudeFrame | Error> = {}) {
  const emitted = new EventEmitter();
  const events: SessionEvent<TerminalEvent>[] = [];
  const frames: ClaudeFrame[] = [];
  const commands: TerminalCommand[] = [];
  const decoder = new ClaudeDecoder();
  let stops = 0;
  let breakStream = false;
  const after: unknown[] = [];
  function output(frame: ClaudeFrame) { bytes(Buffer.from(JSON.stringify(frame) + '\n')); }
  function bytes(data: Buffer) {
    events.push({ cursor: { streamId: 'a'.repeat(32), sequence: events.length + 1 }, data: { type: 'output', channel: 'stdout', data: data.toString('base64') }, sessionId: 'test', messageId: 'msg_' + '1'.repeat(32), createdAt: new Date() });
    emitted.emit('output');
  }
  const session: AgentSession = {
    id: 'test',
    async request(command) { commands.push(command); return { ok: true }; },
    async dispatch(command) {
      commands.push(command);
      if (command.type === 'input') for (const frame of decoder.push(Buffer.from(command.data, 'base64'))) {
        frames.push(frame);
        if (frame.type === 'control_request') {
          const subtype = String(object(frame.request).subtype);
          if (object(frame.request).subtype === 'set_model' && modelResponse === 'pending') continue;
          if (object(frame.request).subtype === 'set_model' && modelResponse === 'error') {
            output({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Model unavailable' } }); continue;
          }
          const response = responses[subtype];
          if (response instanceof Error) output({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: response.message } });
          else output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: subtype === 'initialize' ? initialization : response ?? {} } });
        }
      }
      return { id: 'msg_' + '2'.repeat(32), state: 'accepted', acceptedAt: new Date(), async status() { return { id: 'msg_' + '2'.repeat(32), state: 'handled', acceptedAt: new Date(), startedAt: new Date(), handledAt: new Date() }; } };
    },
    async *stream(options) {
      after.push(options?.after);
      let index = options?.after?.sequence ?? 0;
      while (!options?.signal?.aborted) {
        if (!events[index]) await once(emitted, 'output', { signal: options?.signal });
        if (events[index]) yield events[index++]!;
        if (breakStream) { breakStream = false; throw new Error('network stream terminated'); }
      }
    },
    async stop() { stops++; },
  };
  const agent = new RemoteAgent(session, { controlTimeoutMs: 2000, stopTimeoutMs: 100, ...options });
  return { agent, frames, commands, output, bytes, events, after, session, get stops() { return stops; }, breakNextStream() { breakStream = true; } };
}

test('headless Claude uses bidirectional JSON and only interactive invocations use the local UI', () => {
  assert.equal(useLocalTui([], true), true);
  assert.equal(useLocalTui(['--model', 'sonnet'], true), true);
  for (const argv of [['-p'], ['--help'], ['--version'], ['--output-format=json']]) assert.equal(useLocalTui(argv, true), false);
  assert.equal(useLocalTui([], false), false);
  assert.deepEqual(headlessArguments(['--model', 'sonnet']).slice(-2), ['--permission-prompt-tool', 'stdio']);
});

test('JSONL decoding survives arbitrary byte splits and rejects truncated or oversized frames', () => {
  const decoder = new ClaudeDecoder();
  const input = Buffer.from(JSON.stringify({ type: 'text', text: '🍈 café\nhello' }) + '\n');
  const decoded = [...input].flatMap(byte => decoder.push(Buffer.from([byte])));
  assert.deepEqual(decoded, [{ type: 'text', text: '🍈 café\nhello' }]);
  decoder.finish();
  assert.throws(() => new ClaudeDecoder().push(Buffer.from('null\n')), /Invalid/);
  const incomplete = new ClaudeDecoder(); incomplete.push(Buffer.from('{"type":'));
  assert.throws(() => incomplete.finish(), /incomplete/);
  assert.throws(() => new ClaudeDecoder().push(Buffer.alloc(4 * 1024 * 1024 + 1, 65)), /limit/);
});

test('commands are available before the first prompt and init updates retain their descriptions', async t => {
  const command = { name: 'compact', description: 'Summarize conversation history', argumentHint: '[instructions]' };
  const f = fixture({}, { commands: [command, { name: 'project:review', description: 'Review this project' }] });
  t.after(() => f.agent.close());
  let readyCommands: unknown;
  f.agent.on('status', status => { if (status === 'ready') readyCommands = f.agent.commands; });
  await f.agent.start();
  assert.deepEqual(readyCommands, [command, { name: 'project:review', description: 'Review this project', argumentHint: '' }]);
  assert.equal(f.frames.some(frame => frame.type === 'user'), false, 'Command discovery must not spend a model turn');
  f.output({ type: 'system', subtype: 'init', slash_commands: ['compact', 'new-command'] });
  await until(() => f.agent.commands.some(command => command.name === 'new-command'));
  assert.deepEqual(f.agent.commands, [command, { name: 'new-command', description: '', argumentHint: '' }]);
  const activity: unknown[][] = [];
  f.agent.on('activity', (...args) => activity.push(args));
  await f.agent.submit('/compact keep the decisions');
  assert.deepEqual(activity, [[]], 'Activity events must never carry the prompt');
  assert.equal(object(f.frames.at(-1)?.message).content, '/compact keep the decisions');
});

test('command metadata tolerates missing fields and rejects invalid names', () => {
  assert.deepEqual(slashCommands(undefined), []);
  assert.deepEqual(slashCommands([null, {}, { name: 4 }, { name: '/help' }, { name: 'bad\nname' }, { name: '\x1b[31mevil' }, 'compact', 'compact', { name: 'plugin:review', description: false, argumentHint: 3 }]), [
    { name: 'compact', description: '', argumentHint: '' },
    { name: 'plugin:review', description: '', argumentHint: '' },
  ]);
  assert.deepEqual(slashCommands([{ name: 'code-review', description: 'Review changes', aliases: ['review', '/bad', 'bad name', null, 'review'] }]).map(command => command.name), ['code-review', 'review']);
});

test('models come from Claude and switching uses a control request in the same conversation', async t => {
  const models = [
    { value: 'default', displayName: 'Default', description: 'Use the default model' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks' },
  ];
  const f = fixture({}, { models });
  t.after(() => f.agent.close());
  await f.agent.start(['--model', 'opus']);
  assert.deepEqual(f.agent.models, models);
  assert.equal(f.agent.model, 'opus');
  await f.agent.setModel('sonnet');
  assert.equal(f.agent.model, 'sonnet');
  assert.equal(f.agent.status, 'ready');
  assert.deepEqual(object(f.frames.at(-1)?.request), { subtype: 'set_model', model: 'sonnet' });
  assert.equal(f.frames.some(frame => frame.type === 'user'), false, 'A model change must not submit a model prompt');
  await f.agent.submit('Continue the conversation');
  assert.equal(object(f.frames.at(-1)?.message).content, 'Continue the conversation');
  assert.equal(f.commands.filter(command => command.type === 'start').length, 1, 'Switching must retain the remote process');
});

test('model refresh replaces stale metadata on each read without changing the session or submitting a turn', async t => {
  const old = { value: 'opus', displayName: 'Opus', description: 'Previous version', resolvedModel: 'provider.opus-old' };
  const latest = { ...old, description: 'Latest version', resolvedModel: 'provider.opus-new', supportedEffortLevels: ['low', 'high'] };
  const responses: Record<string, ClaudeFrame | Error> = { list_models: { models: [latest] } };
  const f = fixture({}, { models: [old] }, 'success', responses);
  t.after(() => f.agent.close());
  await f.agent.start(['--model', 'opus']);
  const updates: unknown[] = [];
  f.agent.on('models', models => updates.push(models));
  assert.deepEqual(await f.agent.refreshModels(), [latest]);
  assert.deepEqual(updates, [[latest]]);
  assert.equal(f.agent.model, 'opus');
  assert.equal(f.agent.status, 'ready');
  responses.list_models = { models: [{ value: 'provider.new-model', displayName: 'New model' }] };
  f.agent.status = 'working';
  await f.agent.refreshModels();
  assert.equal(f.agent.models[0]?.value, 'provider.new-model');
  assert.equal(f.agent.status, 'working', 'Reading the catalog must preserve an active turn');
  assert.equal(f.frames.filter(frame => object(frame.request).subtype === 'list_models').length, 2);
  assert.equal(f.commands.filter(command => command.type === 'start').length, 1);
  assert.equal(f.frames.some(frame => frame.type === 'user'), false);
  assert.equal(f.commands.some(command => command.type === 'save-settings'), false);
});

test('unsupported model refresh retains the startup catalog and remembers the missing capability', async t => {
  const models = [{ value: 'provider.model', displayName: 'Provider model', description: '' }];
  const f = fixture({}, { models }, 'success', { list_models: new Error('Unsupported control request subtype: list_models') });
  t.after(() => f.agent.close());
  await f.agent.start();
  assert.deepEqual(await f.agent.refreshModels(), models);
  assert.deepEqual(await f.agent.refreshModels(), models);
  assert.equal(f.frames.filter(frame => object(frame.request).subtype === 'list_models').length, 1);
  assert.equal(f.agent.status, 'ready');
});

test('failed model reads preserve the catalog for retry, while a successful empty list clears it', async t => {
  const models = [{ value: 'provider.model', displayName: 'Provider model', description: '' }];
  const responses: Record<string, ClaudeFrame | Error> = { list_models: new Error('Catalog temporarily unavailable') };
  const f = fixture({}, { models }, 'success', responses);
  t.after(() => f.agent.close());
  await f.agent.start();
  await assert.rejects(f.agent.refreshModels(), /Catalog temporarily unavailable/);
  assert.deepEqual(f.agent.models, models);
  responses.list_models = {};
  await assert.rejects(f.agent.refreshModels(), /did not provide a model list/);
  assert.deepEqual(f.agent.models, models);
  responses.list_models = { models: [] };
  assert.deepEqual(await f.agent.refreshModels(), []);
  assert.deepEqual(f.agent.models, []);
  assert.equal(f.agent.status, 'ready');
});

test('model changes wait for confirmation and block concurrent submissions', async t => {
  const f = fixture({}, {}, 'pending');
  t.after(() => f.agent.close());
  await f.agent.start(['--model=opus']);
  const changing = f.agent.setModel('sonnet');
  await until(() => object(f.frames.at(-1)?.request).subtype === 'set_model');
  assert.equal(f.agent.status, 'configuring');
  assert.equal(f.agent.model, 'opus', 'The current model changes only after acknowledgment');
  await assert.rejects(f.agent.submit('too early'), /still working/);
  await assert.rejects(f.agent.setModel('haiku'), /Wait for Claude/);
  const request = f.frames.at(-1)!;
  f.output({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
  await changing;
  assert.equal(f.agent.model, 'sonnet');
  assert.equal(f.agent.status, 'ready');
});

test('rejected model changes preserve the current model and leave the session usable', async t => {
  const f = fixture({}, {}, 'error');
  t.after(() => f.agent.close());
  await f.agent.start();
  for (const value of ['', 'sonnet extra', 'sonnet\n', '\x1b[31msonnet']) await assert.rejects(f.agent.setModel(value), /one model/);
  await assert.rejects(f.agent.setModel('provider.custom-model'), /Model unavailable/);
  assert.equal(f.agent.model, 'default');
  assert.equal(f.agent.status, 'ready');
  await f.agent.submit('Still usable');
  assert.equal(object(f.frames.at(-1)?.message).content, 'Still usable');
});

test('model metadata uses provider names without inventing a fallback catalog', () => {
  assert.deepEqual(modelOptions(undefined), []);
  assert.deepEqual(modelOptions([null, {}, { value: '' }, { value: 'bad\nmodel' }, { value: 'custom', description: 7 }, { value: 'sonnet', displayName: 'Sonnet', description: 'A model' }]), [
    { value: 'custom', displayName: 'custom', description: '' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'A model' },
  ]);
});

test('startup displays Claude’s effective saved model and explicit launch overrides without saving them', async t => {
  for (const model of ['provider.saved-model', 'sonnet']) {
    const f = fixture({}, {}, 'success', { get_settings: { effective: { model: 'provider.saved-model' }, applied: { model } } });
    t.after(() => f.agent.close());
    await f.agent.start(model === 'sonnet' ? ['--model', 'sonnet'] : []);
    assert.equal(f.agent.model, model);
    assert.equal(f.commands.some(command => command.type === 'save-settings'), false);
  }
});

test('only acknowledged menu choices are saved, including false and default values', async t => {
  const f = fixture(); t.after(() => f.agent.close()); await f.agent.start();
  await f.agent.setModel('sonnet');
  await f.agent.configure({ subtype: 'set_permission_mode', mode: 'acceptEdits' });
  await f.agent.configure({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high', outputStyle: 'Learning', fastMode: false } });
  await f.agent.configure({ subtype: 'set_permission_mode', mode: 'default' });
  await f.agent.configure({ subtype: 'set_permission_mode', mode: 'plan' }, { persist: false });
  assert.equal(f.agent.info.current_permission_mode, 'plan', 'Shift+Tab changes the running session without saving a default');
  await f.agent.configure({ subtype: 'rename_session', title: 'Only this conversation' });
  assert.deepEqual(f.commands.filter(command => command.type === 'save-settings').map(command => command.settings), [
    { model: 'sonnet' }, { permissionMode: 'acceptEdits' }, { effortLevel: 'high', outputStyle: 'Learning', fastMode: false }, { permissionMode: 'default' },
  ]);
  assert.equal(f.frames.some(frame => frame.type === 'user'), false);

  const rejected = fixture({}, {}, 'error', { set_permission_mode: new Error('Rejected'), apply_flag_settings: new Error('Rejected') });
  t.after(() => rejected.agent.close()); await rejected.agent.start();
  await assert.rejects(rejected.agent.setModel('sonnet'));
  await assert.rejects(rejected.agent.configure({ subtype: 'set_permission_mode', mode: 'acceptEdits' }));
  await assert.rejects(rejected.agent.configure({ subtype: 'apply_flag_settings', settings: { fastMode: true } }));
  assert.equal(rejected.commands.some(command => command.type === 'save-settings'), false);
});

test('save failures report that the current choice applied and keep the session usable', async t => {
  const f = fixture(); t.after(() => f.agent.close()); await f.agent.start();
  const request = f.session.request;
  f.session.request = async (command, options) => command.type === 'save-settings' ? { ok: false, error: 'Disk full' } : request(command, options);
  await assert.rejects(f.agent.setModel('sonnet'), /Changed for this session, but could not save for future sessions: Disk full/);
  assert.equal(f.agent.model, 'sonnet');
  await assert.rejects(f.agent.configure({ subtype: 'set_permission_mode', mode: 'plan' }), /could not save/);
  assert.equal(f.agent.info.current_permission_mode, 'plan');
  await assert.rejects(f.agent.configure({ subtype: 'apply_flag_settings', settings: { outputStyle: 'Learning' } }), /could not save/);
  assert.equal(f.agent.info.output_style, 'Learning');
  assert.equal(f.agent.status, 'ready');
  await f.agent.submit('Still usable');
});

test('menu reads and changes use the same control channel without user turns', async t => {
  const f = fixture({}, { output_style: 'Custom', available_output_styles: ['Custom'], account: { secret: 'private' } }, 'success', { get_settings: { effective: { effortLevel: 'low' } } });
  t.after(() => f.agent.close()); await f.agent.start();
  assert.equal(f.agent.info.account, undefined, 'Only public menu metadata is retained');
  assert.deepEqual(f.agent.info.available_output_styles, ['Custom']);
  assert.deepEqual(await f.agent.query({ subtype: 'get_settings' }), { effective: { effortLevel: 'low' } });
  assert.equal(f.agent.status, 'ready');
  await f.agent.configure({ subtype: 'apply_flag_settings', settings: { outputStyle: 'Workspace' } });
  assert.equal(f.agent.info.output_style, 'Workspace');
  await f.agent.configure({ subtype: 'set_permission_mode', mode: 'plan' });
  assert.equal(f.agent.info.current_permission_mode, 'plan');
  assert.equal(f.frames.some(frame => frame.type === 'user'), false);
  await f.agent.submit('A normal prompt');
  await f.agent.query({ subtype: 'mcp_status' });
  assert.equal(f.agent.status, 'working', 'A read must not reset an ongoing turn');
  await assert.rejects(f.agent.configure({ subtype: 'set_permission_mode', mode: 'default' }), /Wait for Claude/);
  assert.equal(f.commands.filter(command => command.type === 'start').length, 1);
});

test('settings menu snapshots reuse startup and refresh after changes and model turns', async t => {
  const responses = { get_settings: { applied: { effort: 'low' } } };
  const f = fixture({}, {}, 'success', responses);
  t.after(() => f.agent.close()); await f.agent.start();
  const reads = () => f.frames.filter(frame => object(frame.request).subtype === 'get_settings').length;
  assert.equal(reads(), 1);
  assert.equal(object((await f.agent.query({ subtype: 'get_settings' }, { cached: true })).applied).effort, 'low');
  assert.equal(reads(), 1);
  responses.get_settings = { applied: { effort: 'high' } };
  await f.agent.configure({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
  assert.equal(object((await f.agent.query({ subtype: 'get_settings' }, { cached: true })).applied).effort, 'high');
  assert.equal(reads(), 2);
  await f.agent.query({ subtype: 'get_settings' }, { cached: true });
  assert.equal(reads(), 2);
  await f.agent.query({ subtype: 'get_settings' });
  assert.equal(reads(), 3, 'Explicit fresh reads always reach Claude');
  await f.agent.setModel('sonnet');
  await f.agent.query({ subtype: 'get_settings' }, { cached: true });
  assert.equal(reads(), 4);
  await f.agent.submit('A tool might edit settings');
  for (let index = 0; index < 2; index++) await f.agent.query({ subtype: 'get_settings' }, { cached: true });
  assert.equal(reads(), 6, 'Settings may change while a model turn is running');
  f.output({ type: 'result', result: 'Done' });
  await until(() => f.agent.status === 'ready');
  await f.agent.query({ subtype: 'get_settings' }, { cached: true });
  assert.equal(reads(), 7);
});

test('a settings read started before a change cannot repopulate the menu cache', async t => {
  const f = fixture(); t.after(() => f.agent.close()); await f.agent.start();
  const dispatch = f.session.dispatch;
  let pending: ClaudeFrame | undefined;
  f.session.dispatch = async (command, options) => {
    if (command.type === 'input') {
      const frame = JSON.parse(Buffer.from(command.data, 'base64').toString()) as ClaudeFrame;
      if (object(frame.request).subtype === 'get_settings') { pending = frame; return {} as Awaited<ReturnType<AgentSession['dispatch']>>; }
    }
    return dispatch(command, options);
  };
  const reading = f.agent.query({ subtype: 'get_settings' });
  await until(() => !!pending);
  await f.agent.configure({ subtype: 'set_permission_mode', mode: 'plan' });
  f.output({ type: 'control_response', response: { subtype: 'success', request_id: pending!.request_id, response: { effective: { permissions: { defaultMode: 'default' } } } } });
  await reading;
  f.session.dispatch = dispatch;
  const before = f.frames.length;
  await f.agent.query({ subtype: 'get_settings' }, { cached: true });
  assert.equal(f.frames.length, before + 1);
});

test('settings menu snapshots expire so external edits become visible', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const responses = { get_settings: { applied: { effort: 'low' } } };
  const f = fixture({}, {}, 'success', responses);
  t.after(() => f.agent.close()); await f.agent.start();
  responses.get_settings = { applied: { effort: 'high' } };
  now += 30_001;
  assert.equal(object((await f.agent.query({ subtype: 'get_settings' }, { cached: true })).applied).effort, 'high');
  assert.equal(f.frames.filter(frame => object(frame.request).subtype === 'get_settings').length, 2);
});

test('rejected menu changes preserve metadata and unsupported read capabilities are cached per process', async t => {
  const f = fixture({}, { current_permission_mode: 'default' }, 'success', {
    set_permission_mode: new Error('Policy rejected the change'),
    get_hooks_listing: new Error('Unsupported control request subtype: get_hooks_listing'),
  });
  t.after(() => f.agent.close()); await f.agent.start();
  await assert.rejects(f.agent.configure({ subtype: 'set_permission_mode', mode: 'acceptEdits' }), /Policy rejected/);
  assert.equal(f.agent.status, 'ready');
  assert.equal(f.agent.info.current_permission_mode, 'default');
  for (let i = 0; i < 2; i++) await assert.rejects(f.agent.query({ subtype: 'get_hooks_listing' }), /Unsupported/);
  assert.equal(f.frames.filter(frame => object(frame.request).subtype === 'get_hooks_listing').length, 1);
  await f.agent.submit('Still usable');
});

test('task menus track remote snapshots and can stop a task without resetting an ongoing turn', async t => {
  const f = fixture(); t.after(() => f.agent.close()); await f.agent.start();
  f.output({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'shell-1', description: 'Run checks', task_type: 'local_bash' }] });
  await until(() => f.agent.tasks.size === 1);
  assert.equal(f.agent.tasks.get('shell-1')?.status, 'running');
  await f.agent.submit('Keep working');
  await f.agent.configure({ subtype: 'stop_task', task_id: 'shell-1' });
  assert.equal(f.agent.status, 'working');
  f.output({ type: 'system', subtype: 'task_updated', task_id: 'shell-1', patch: { status: 'killed' } });
  await until(() => f.agent.tasks.get('shell-1')?.status === 'killed');
  f.output({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await until(() => f.agent.tasks.size === 0);
  assert.equal(f.frames.filter(frame => frame.type === 'user').length, 1);
});

test('one process handles initialization, multiple prompts, approval answers and interruption through dispatch', async t => {
  const f = fixture(); t.after(() => f.agent.close());
  await f.agent.start(['--model', 'sonnet']);
  assert.equal(f.agent.status, 'ready');
  assert.equal(f.commands.filter(command => command.type === 'start').length, 1);
  assert.equal(f.commands.filter(command => command.type === 'start')[0]?.tty, false);
  await assert.rejects(f.agent.submit('\\'.repeat(512 * 1024)), /too large/);
  assert.equal(f.agent.status, 'ready', 'An oversized encoded prompt must not wedge the session');
  await f.agent.submit('A whole prompt 🍈\nwith a second line');
  const user = f.frames.find(frame => frame.type === 'user')!;
  assert.equal(object(user.message).content, 'A whole prompt 🍈\nwith a second line');
  await assert.rejects(f.agent.submit('while busy'), /still working/);
  f.output({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/workspace/test', content: 'safe' } } });
  await until(() => f.agent.approvals.size === 1);
  await f.agent.answer('permission-1', false);
  assert.deepEqual(object(f.frames.at(-1)?.response).response, { behavior: 'deny', message: 'The user declined this request.' });
  f.output({ type: 'control_request', request_id: 'permission-2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } } });
  await until(() => f.agent.approvals.size === 1);
  await f.agent.answer('permission-2', true, { 'Which?': 'First' });
  assert.deepEqual(object(f.frames.at(-1)?.response).response, { behavior: 'allow', updatedInput: { questions: [], answers: { 'Which?': 'First' } } });
  await assert.rejects(f.agent.answer('permission-2', true), /no longer active/);
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
  f.output({ type: 'control_request', request_id: 'permission-3', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: suggestions } });
  await until(() => f.agent.approvals.size === 1);
  assert.deepEqual(f.agent.approvals.get('permission-3')?.suggestions, suggestions);
  await f.agent.answer('permission-3', true, undefined, { suggestions });
  assert.deepEqual(object(f.frames.at(-1)?.response).response, { behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: suggestions });
  f.output({ type: 'control_request', request_id: 'permission-4', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
  await until(() => f.agent.approvals.size === 1);
  await f.agent.answer('permission-4', false, undefined, { message: 'Keep the build directory' });
  assert.deepEqual(object(f.frames.at(-1)?.response).response, { behavior: 'deny', message: 'The user declined this request and said: Keep the build directory' });
  f.output({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
  await until(() => f.agent.info.current_permission_mode === 'plan');
  f.output({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
  await until(() => f.agent.info.current_permission_mode === 'default');
  await f.agent.interrupt();
  assert.equal(object(f.frames.at(-1)?.request).subtype, 'interrupt');
  f.output({ type: 'result', is_error: false, result: 'Interrupted' });
  await until(() => f.agent.status === 'ready');
  await f.agent.submit('The next turn');
  assert.equal(f.frames.filter(frame => frame.type === 'user').length, 2);
  await f.agent.close(); await f.agent.close(); assert.equal(f.stops, 1);
});

test('large prompts retain frame boundaries and output replay resumes a split UTF-8 JSON line', async t => {
  const f = fixture(); t.after(() => f.agent.close());
  const received: ClaudeFrame[] = []; f.agent.on('frame', frame => received.push(frame));
  await f.agent.start();
  const text = '🍈'.repeat(16_000);
  await f.agent.submit(text);
  assert.equal(object(f.frames.find(frame => frame.type === 'user')?.message).content, text);
  assert.ok(f.commands.filter(command => command.type === 'input').every(command => Buffer.from(command.data, 'base64').length <= 16 * 1024));
  const raw = Buffer.from('{"type":"result","result":"🍈"}\n');
  const split = raw.indexOf(Buffer.from('🍈')) + 1;
  const beforeSplit = f.events.length;
  f.breakNextStream(); f.bytes(raw.subarray(0, split));
  await delay(20); f.bytes(raw.subarray(split));
  await until(() => received.some(frame => frame.type === 'result'));
  assert.equal(received.filter(frame => frame.type === 'result').length, 1);
  assert.equal(f.after.length, 2);
  assert.equal((f.after[1] as { sequence: number }).sequence, beforeSplit + 1);
});

test('unknown control requests fail closed; cancellation removes stale approvals', async t => {
  const f = fixture(); t.after(() => f.agent.close()); await f.agent.start();
  f.output({ type: 'control_request', request_id: 'unknown', request: { subtype: 'something_new' } });
  await until(() => f.frames.some(frame => object(frame.response).request_id === 'unknown'));
  assert.equal(object(f.frames.at(-1)?.response).subtype, 'error');
  f.output({ type: 'control_request', request_id: 'stale', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
  await until(() => f.agent.approvals.size === 1);
  f.output({ type: 'control_cancel_request', request_id: 'stale' });
  await until(() => f.agent.approvals.size === 0);
  await assert.rejects(f.agent.answer('stale', true), /no longer active/);
});
