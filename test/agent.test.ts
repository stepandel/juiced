import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { SessionEvent } from '@cantelop/sdk';
import { ClaudeDecoder, headlessArguments, object, slashCommands, useLocalTui, type ClaudeFrame } from '../src/agent-protocol.js';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import type { TerminalCommand, TerminalEvent } from '../src/protocol.js';

export async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(5); }
}

function fixture(options: ConstructorParameters<typeof RemoteAgent>[1] = {}, initialization: ClaudeFrame = {}) {
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
          output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: object(frame.request).subtype === 'initialize' ? initialization : {} } });
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
  await f.agent.submit('/compact keep the decisions');
  assert.equal(object(f.frames.at(-1)?.message).content, '/compact keep the decisions');
});

test('command metadata tolerates missing fields and rejects invalid names', () => {
  assert.deepEqual(slashCommands(undefined), []);
  assert.deepEqual(slashCommands([null, {}, { name: 4 }, { name: '/help' }, { name: 'bad\nname' }, { name: '\x1b[31mevil' }, 'compact', 'compact', { name: 'plugin:review', description: false, argumentHint: 3 }]), [
    { name: 'compact', description: '', argumentHint: '' },
    { name: 'plugin:review', description: '', argumentHint: '' },
  ]);
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
  f.breakNextStream(); f.bytes(raw.subarray(0, split));
  await delay(20); f.bytes(raw.subarray(split));
  await until(() => received.some(frame => frame.type === 'result'));
  assert.equal(received.filter(frame => frame.type === 'result').length, 1);
  assert.equal(f.after.length, 2);
  assert.equal((f.after[1] as { sequence: number }).sequence, 2);
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
});


test('a prompt waits for sync and a sync failure never dispatches its contents', async () => {
  let release!: () => void;
  const f=fixture({beforeSubmit:()=>new Promise<void>(resolve=>release=resolve)});
  try {
    await f.agent.start();const submitted=f.agent.submit('read the synced README');
    assert.equal(f.agent.status,'working');assert.equal(f.frames.some(frame=>frame.type==='user'),false);
    await assert.rejects(f.agent.submit('second'),/still working/);release();await submitted;
    assert.equal(f.frames.filter(frame=>frame.type==='user').length,1);
  } finally { await f.agent.close(); }
  const gated=fixture({beforeSubmit:async()=>{throw new Error('sync unavailable');}});
  try { await gated.agent.start();await assert.rejects(gated.agent.submit('never send'),/sync unavailable/);
    assert.equal(gated.agent.status,'ready');assert.equal(gated.frames.some(frame=>frame.type==='user'),false);
  } finally { await gated.agent.close(); }
});


test('interrupting during reconciliation never submits the waiting prompt', async () => {
  let release!: () => void;
  const f = fixture({ beforeSubmit: () => new Promise<void>(resolve => release = resolve) });
  try {
    await f.agent.start();
    const submitted = f.agent.submit('interrupted before upload');
    const rejection = assert.rejects(submitted, /interrupted before sending/);
    await f.agent.interrupt(); release(); await rejection;
    assert.equal(f.frames.some(frame => frame.type === 'user'), false);
  } finally { await f.agent.close(); }
});

test('a permission cancelled during reconciliation cannot be granted afterward', async () => {
  let release!: () => void;
  const f = fixture({ beforeSubmit: () => new Promise<void>(resolve => release = resolve) });
  try {
    await f.agent.start();
    f.output({ type: 'control_request', request_id: 'pending', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
    await until(() => f.agent.approvals.has('pending'));
    const answer = f.agent.answer('pending', true);
    const rejection = assert.rejects(answer, /no longer active/);
    f.output({ type: 'control_cancel_request', request_id: 'pending' });
    await until(() => !f.agent.approvals.has('pending'));
    release(); await rejection;
    assert.equal(f.frames.some(frame => frame.type === 'control_response' && object(frame.response).request_id === 'pending'), false);
  } finally { await f.agent.close(); }
});
