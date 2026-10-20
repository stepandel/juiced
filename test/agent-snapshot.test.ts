import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSnapshotProjection, MAX_AGENT_SNAPSHOT_BYTES, readAgentSnapshot } from '../src/agent-snapshot.js';
import type { AgentJournalEvent } from '../src/protocol.js';
import { AgentJournal } from '../src/runtime/agent-journal.js';
import { mkdtemp, rm } from 'node:fs/promises';

function projection() {
  const state = new AgentSnapshotProjection();
  let sequence = 0;
  const event = (event: AgentJournalEvent) => { state.observe({ sequence: ++sequence, event }); };
  const raw = (bytes: Buffer) => event({ type: 'bytes', channel: 'stdout', data: bytes.toString('base64') });
  const frame = (frame: object) => raw(Buffer.from(JSON.stringify(frame) + '\n'));
  return { event, raw, frame, view: () => state.view(sequence), snapshot: () => readAgentSnapshot(state.view(sequence).snapshot) };
}

test('a bounded view retains recent display, stream identity and exact permissions across large histories', () => {
  const f = projection();
  f.event({ type: 'reset', epoch: 'native-process', interrupted: false });
  for (let index = 0; index < 100; index++) {
    f.frame({ type: 'assistant', message: { id: `old-${index}`, content: [{ type: 'text', text: `OLD_${index}` }] } });
    f.frame({ type: 'result' });
  }
  f.frame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'current' } } });
  f.frame({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '🍈\n"'.repeat(20_000) } } });
  for (let index = 0; index < 25; index++) f.frame({ type: 'assistant', message: { id: `tool-${index}`, content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: { command: 'x'.repeat(1000) } }] } });
  const input = { file_path: '/workspace/test', content: 'approval\n🍈"'.repeat(3000) };
  f.frame({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Write', input } });
  f.event({ type: 'state', state: 'working' });
  const snapshot = f.snapshot()!;
  assert.ok(snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(f.view())) < 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_AGENT_SNAPSHOT_BYTES);
  assert.deepEqual(snapshot.approvals[0]?.input, input);
  assert.equal(snapshot.conversation.streamId, 'current');
  assert.equal(snapshot.conversation.streamIndex, 0);
  assert.ok(snapshot.conversation.live.length <= 12);
  assert.equal(JSON.stringify(snapshot.conversation).includes('OLD_0"'), false);
  assert.equal(snapshot.state, 'working');
  f.event({ type: 'approval-answer', id: 'permission' });
  assert.equal(f.snapshot()?.approvals.length, 0);
});

test('a snapshot stops before split UTF-8 JSON and multi-chunk user messages', () => {
  const f = projection();
  f.event({ type: 'reset', epoch: 'process', interrupted: false });
  const before = f.snapshot()!.sequence;
  const bytes = Buffer.from(JSON.stringify({ type: 'assistant', message: { id: 'split', content: [{ type: 'text', text: 'split 🍈 output' }] } }) + '\n');
  const at = bytes.indexOf(Buffer.from('🍈')) + 1;
  f.raw(bytes.subarray(0, at));
  f.event({ type: 'state', state: 'working' });
  assert.equal(f.snapshot()?.sequence, before);
  f.raw(bytes.subarray(at));
  assert.equal(f.snapshot()?.conversation.live[0]?.text, 'split 🍈 output');
  const boundary = f.snapshot()!.sequence;
  f.event({ type: 'user', id: 'user', data: Buffer.from('split ').toString('base64'), final: false });
  assert.equal(f.snapshot()?.sequence, boundary);
  f.event({ type: 'user', id: 'user', data: Buffer.from('prompt').toString('base64'), final: true });
  assert.equal(f.snapshot()?.conversation.live[0]?.text, 'split prompt');
});

test('oversized pending permissions use journal recovery instead of truncated tool input', () => {
  const f = projection();
  f.event({ type: 'reset', epoch: 'process', interrupted: false });
  f.frame({ type: 'control_request', request_id: 'large', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { content: 'x'.repeat(80_000) } } });
  assert.equal(f.snapshot(), undefined);
  f.event({ type: 'approval-answer', id: 'large' });
  assert.ok(f.snapshot());
  assert.equal(readAgentSnapshot({ version: 2 }), undefined);
  assert.equal(readAgentSnapshot({ ...f.snapshot(), conversation: { ...f.snapshot()!.conversation, live: [{}] } }), undefined);
  f.frame({ type: 'control_request', request_id: 'unknown', request: { subtype: 'unsupported' } });
  assert.equal(f.snapshot(), undefined, 'Recovery must still send the explicit unsupported-control rejection');
  f.event({ type: 'approval-answer', id: 'unknown' });
  assert.ok(f.snapshot());
});

test('process loss clears permissions and preserves an interrupted display', () => {
  const f = projection();
  f.event({ type: 'reset', epoch: 'old', interrupted: false });
  f.frame({ type: 'control_request', request_id: 'old', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
  f.event({ type: 'reset', epoch: '', interrupted: true });
  f.event({ type: 'state', state: 'sleeping' });
  const snapshot = f.snapshot()!;
  assert.equal(snapshot.approvals.length, 0);
  assert.equal(snapshot.state, 'sleeping');
  assert.equal(snapshot.conversation.history.at(-1)?.entries.at(-1)?.text, 'Interrupted');
});

test('runtime replacement rebuilds the same snapshot and menu metadata from the durable journal', async t => {
  const root = await mkdtemp('/tmp/juiced-snapshot-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new AgentSnapshotProjection();
  const journal = new AgentJournal(root, 'session', entry => original.observe(entry));
  await journal.open();
  await journal.event({ type: 'reset', epoch: 'process', interrupted: false });
  for (const frame of [
    { type: 'system', subtype: 'init', plugins: [{ name: 'test-plugin' }], permissionMode: 'default' },
    { type: 'system', subtype: 'task_started', task_id: 'task', description: 'Background work' },
    { type: 'system', subtype: 'task_updated', task_id: 'task', patch: { description: 'Updated work' } },
    { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Saved output' }] } },
    { type: 'control_request', request_id: 'approve', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'test' } } },
  ]) await journal.event({ type: 'bytes', channel: 'stdout', data: Buffer.from(JSON.stringify(frame) + '\n').toString('base64') });
  const expected = original.view(journal.latest);
  await journal.close();
  const restored = new AgentSnapshotProjection();
  const next = new AgentJournal(root, 'session', entry => restored.observe(entry));
  await next.open();
  try {
    assert.deepEqual(restored.view(next.latest), expected);
    assert.equal(expected.snapshot?.tasks[0]?.description, 'Updated work');
    assert.equal(expected.snapshot?.approvals[0]?.id, 'approve');
    assert.deepEqual(expected.snapshot?.info.plugins, [{ name: 'test-plugin' }]);
  } finally { await next.close(); }
});
