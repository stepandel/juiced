import assert from 'node:assert/strict';
import test from 'node:test';
import { edit, cursorParts } from '../src/tui/editor.js';
import { emptyConversation, plain, receiveFrame, userTurn } from '../src/tui/conversation.js';

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
