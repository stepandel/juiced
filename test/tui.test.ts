import assert from 'node:assert/strict';
import test from 'node:test';
import { edit, cursorParts } from '../src/tui/editor.js';
import { emptyConversation, plain, receiveFrame, userTurn } from '../src/tui/conversation.js';
import { availableCommands, matchingCommands } from '../src/tui/commands.js';

test('command suggestions filter the command word and preserve local command behavior', () => {
  const commands = availableCommands([
    { name: 'compact', description: 'Summarize history', argumentHint: '[instructions]' },
    { name: 'project:review', description: 'Review project', argumentHint: '' },
    { name: 'help', description: 'Remote help', argumentHint: 'ignored' },
  ]);
  const matches = (text: string, cursor = text.length) => matchingCommands({ text, cursor }, commands);
  assert.deepEqual(matches('/'), commands);
  assert.equal(commands.find(command => command.name === 'help')?.description, 'Show Juiced keyboard shortcuts');
  assert.deepEqual(matches('/COM').map(command => command.name), ['compact']);
  assert.deepEqual(matches('/project:').map(command => command.name), ['project:review']);
  for (const text of ['hello /co', '/compact instructions', '/co\n', '/unknown', '']) assert.deepEqual(matches(text), []);
  assert.deepEqual(matches('/compact', 3), []);
});

test('the local prompt editor supports grapheme navigation, forward deletion, multiline paste and line editing', () => {
  let state = { text: '', cursor: 0 };
  state = edit(state, 'A👩‍💻🍈', {});
  state = edit(state, '', { leftArrow: true });
  state = edit(state, '', { backspace: true });
  assert.deepEqual(state, { text: 'A🍈', cursor: 1 });
  assert.deepEqual(cursorParts(state), ['A', '🍈', '']);
  state = edit(state, '', { delete: true });
  assert.deepEqual(state, { text: 'A', cursor: 1 });
  state = edit(state, '\nsecond\r\nthird', {});
  assert.equal(state.text, 'A\nsecond\nthird');
  state = edit(state, '', { home: true });
  state = edit(state, '', { upArrow: true });
  assert.equal(state.cursor, 2);
  state = edit(state, 'x', {});
  assert.equal(state.text, 'A\nxsecond\nthird');
  state = edit(state, '\x1b\x00', {});
  assert.equal(state.text, 'A\nxsecond\nthird');
});

test('streamed text reconciles with final snapshots without duplicates, tracks tools and commits turns', () => {
  let state = userTurn(emptyConversation(), 'hello');
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const text of ['Hello ', 'world']) state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  state = receiveFrame(state, { type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }] } });
  assert.equal(state.live.filter(entry => entry.kind === 'text').length, 1);
  state = receiveFrame(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '/workspace' }] } });
  assert.equal(state.live.find(entry => entry.id === 'tool-1')?.status, 'done');
  state = receiveFrame(state, { type: 'result', result: 'Hello world', usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(state.history.length, 1); assert.equal(state.live.length, 0);
  assert.equal(state.history[0]?.entries.filter(entry => entry.kind === 'text').length, 1);
  assert.equal(state.tokens, 12);
  assert.equal(plain('\x1b]52;c;malicious\x07hello\x1b[31m\x00'), 'hello');
});

test('an interrupted snapshot with a new ID does not repeat the streamed response or expose native diagnostics', () => {
  let state = userTurn(emptyConversation(), 'A long response');
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1\n2\n3\n' } } });
  state = receiveFrame(state, { type: 'assistant', message: { id: 'interrupted-snapshot', content: [{ type: 'text', text: '1\n2\n3' }] } });
  state = receiveFrame(state, { type: 'result', is_error: true, juiced_interrupted: true, errors: ['internal diagnostic'] });
  assert.equal(state.history[0]?.entries.filter(entry => entry.kind === 'text').length, 1);
  assert.equal(state.history[0]?.entries.at(-1)?.text, 'Interrupted');
});

test('per-block assistant snapshots reconcile text after thinking and tools using the active stream index', () => {
  let state = userTurn(emptyConversation(), 'Check the README');
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'mixed' } } });
  const start = (index: number, block: Record<string, unknown>) => {
    state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } });
  };
  const snapshot = (block: Record<string, unknown>) => {
    state = receiveFrame(state, { type: 'assistant', message: { id: 'mixed', content: [block] } });
  };
  const stop = (index: number) => {
    state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_stop', index } });
  };
  const text = (index: number, streamed: string, complete = streamed) => {
    start(index, { type: 'text', text: '' });
    state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: streamed } } });
    snapshot({ type: 'text', text: complete });
    stop(index);
  };

  start(0, { type: 'thinking', thinking: '' });
  snapshot({ type: 'thinking', thinking: 'Consider the code' });
  stop(0);
  text(1, 'Let me check the code.');
  const tool = { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'README.md' } };
  start(2, { ...tool, input: {} });
  snapshot(tool);
  stop(2);
  text(3, 'The README needs', 'The README needs an update.');
  // Repeated wording in a distinct block must remain visible.
  text(4, 'Let me check the code.');
  state = receiveFrame(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'README contents' }] } });
  state = receiveFrame(state, { type: 'result' });

  assert.deepEqual(state.history[0]?.entries, [
    { id: 'user-0', kind: 'user', text: 'Check the README' },
    { id: 'mixed:1', kind: 'text', text: 'Let me check the code.' },
    { id: 'read', kind: 'tool', text: 'Read README.md', status: 'done' },
    { id: 'mixed:3', kind: 'text', text: 'The README needs an update.' },
    { id: 'mixed:4', kind: 'text', text: 'Let me check the code.' },
  ]);
});

test('an interrupted per-block snapshot can change the message ID after thinking', () => {
  let state = userTurn(emptyConversation(), 'A long response');
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '1\n2\n3\n' } } });
  state = receiveFrame(state, { type: 'assistant', message: { id: 'interrupted-snapshot', content: [{ type: 'text', text: '1\n2\n3' }] } });
  state = receiveFrame(state, { type: 'result', is_error: true, juiced_interrupted: true });
  assert.deepEqual(state.history[0]?.entries.filter(entry => entry.kind === 'text'), [{ id: 'streamed:1', kind: 'text', text: '1\n2\n3' }]);
});

test('full snapshots still reconcile by position and identical text in later messages stays separate', () => {
  let state = userTurn(emptyConversation(), 'Check again');
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Checking.' } } });
  state = receiveFrame(state, { type: 'assistant', message: { id: 'streamed', content: [{ type: 'text', text: 'Checking.' }] } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Partial' } } });
  state = receiveFrame(state, { type: 'assistant', message: { id: 'streamed', content: [{ type: 'text', text: 'Checking.' }, { type: 'text', text: 'Complete.' }] } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_stop' } });
  state = receiveFrame(state, { type: 'assistant', message: { id: 'separate', content: [{ type: 'text', text: 'Checking.' }] } });
  assert.deepEqual(state.live.filter(entry => entry.kind === 'text'), [
    { id: 'streamed:0', kind: 'text', text: 'Checking.' },
    { id: 'streamed:1', kind: 'text', text: 'Complete.' },
    { id: 'separate:0', kind: 'text', text: 'Checking.' },
  ]);
  state = receiveFrame(state, { type: 'result' });
  assert.equal(state.streamId, '');
  assert.equal(state.streamIndex, null);
});
