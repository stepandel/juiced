import assert from 'node:assert/strict';
import test from 'node:test';
import { edit, cursorParts } from '../src/tui/editor.js';
import { duration, emptyConversation, liveEntries, plain, preview, receiveFrame, restoreHistory, toolSummary, turnTokens, userTurn } from '../src/tui/conversation.js';
import React from 'react';
import { renderToString } from 'ink';
import stringWidth from 'string-width';
import { rememberLabel, transcriptLines, transcriptRows, wrapLines } from '../src/tui/app.js';
import { Entries, foldedSummary, rows } from '../src/tui/transcript.js';
import { markdownRows, markdownTail, spans } from '../src/tui/markdown.js';
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

test('restored streaming output prints once and later deltas and snapshots retain their full context', () => {
  let state = receiveFrame(emptyConversation(), { type: 'juiced_user', text: 'Saved prompt' });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed' } } });
  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Saved text' } } });
  state = restoreHistory(state);
  assert.deepEqual(state.history[0]?.entries.map(entry => entry.text), ['Saved prompt', 'Saved text']);
  assert.deepEqual(liveEntries(state), []);
  assert.equal(restoreHistory(state), state, 'Repeating restoration must not duplicate history');

  state = receiveFrame(state, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' plus new text' } } });
  assert.equal(state.live.at(-1)?.text, 'Saved text plus new text', 'Native snapshot reconciliation keeps the original block');
  assert.equal(liveEntries(state)[0]?.text, ' plus new text');
  state = receiveFrame(state, { type: 'assistant', message: { id: 'streamed', content: [{ type: 'text', text: 'Saved text plus new text' }] } });
  state = receiveFrame(state, { type: 'result' });
  assert.deepEqual(state.history[1]?.entries.map(entry => entry.text), [' plus new text']);
  assert.equal(new Set(state.history.map(turn => turn.id)).size, state.history.length, 'Static output IDs stay unique across restored and completed output');
  state = receiveFrame(state, { type: 'juiced_user', text: 'Saved prompt' });
  assert.deepEqual(liveEntries(state).map(entry => entry.text), ['Saved prompt'], 'The next turn can repeat earlier wording');
});

test('restored tools can finish and corrected snapshots remain visible', () => {
  let state = userTurn(emptyConversation(), 'Saved prompt');
  state = receiveFrame(state, { type: 'assistant', message: { id: 'saved', content: [
    { type: 'text', text: 'Initial snapshot' },
    { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'README.md' } },
  ] } });
  state = restoreHistory(state);
  state = receiveFrame(state, { type: 'assistant', message: { id: 'saved', content: [{ type: 'text', text: 'Corrected snapshot' }] } });
  state = receiveFrame(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', is_error: true }] } });
  assert.deepEqual(liveEntries(state).map(entry => [entry.text, entry.status]), [['Corrected snapshot', undefined], ['Read(README.md)', 'failed']]);
  state = receiveFrame(state, { type: 'result', juiced_interrupted: true });
  assert.equal(state.history[1]?.entries.at(-1)?.text, 'Interrupted');
  assert.equal(state.history[1]?.entries.some(entry => entry.kind === 'user'), false);
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
    { id: 'read', kind: 'tool', tool: 'Read', text: 'Read(README.md)', status: 'done', detail: 'Read 1 line', output: 'README contents' },
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

test('tool calls use Claude Code headers and result summaries', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test\n  --watch' }), 'Bash(npm test --watch)');
  assert.equal(toolSummary('Edit', { file_path: '/workspace/src/a.ts' }), 'Update(src/a.ts)');
  assert.equal(toolSummary('Grep', { pattern: 'TODO', path: 'src' }), 'Search(pattern: "TODO", path: "src")');
  assert.equal(toolSummary('mcp__github__get_issue', { number: 4, nested: {} }), 'github - get_issue (MCP)(number: 4)');
  assert.equal(toolSummary('TodoWrite', { todos: [] }), 'Update Todos');

  let state = userTurn(emptyConversation(), 'Work');
  state = receiveFrame(state, { type: 'assistant', message: { id: 'tools', content: [
    { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'seq 1 12' } },
    { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/workspace/notes.txt', content: 'a\nb\n' } },
    { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Build', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] } },
    { type: 'tool_use', id: 'denied', name: 'Bash', input: { command: 'rm -rf build' } },
  ] } });
  state = receiveFrame(state, { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'bash', content: [{ type: 'text', text: Array.from({ length: 12 }, (_, i) => i + 1).join('\n') }] },
    { type: 'tool_result', tool_use_id: 'write', content: 'File created successfully' },
    { type: 'tool_result', tool_use_id: 'todo', content: 'Todos have been modified successfully' },
    { type: 'tool_result', tool_use_id: 'denied', is_error: true, content: "The user doesn't want to proceed with this tool use." },
  ] } });
  const detail = (id: string) => state.live.find(entry => entry.id === id)?.detail;
  assert.equal(detail('bash'), '1\n2\n3\n… +9 lines');
  assert.equal(detail('write'), 'Wrote 2 lines to notes.txt');
  assert.equal(detail('todo'), '☒ Plan\n◼ Build\n☐ Ship');
  assert.equal(detail('denied'), 'User rejected this tool use');
  assert.equal(preview('one\ntwo\n'), 'one\ntwo');
  assert.equal(duration(65_000), '1m 5s');
  state = receiveFrame(state, { type: 'result', duration_ms: 8_300 });
  assert.deepEqual(state.history[0]?.entries.at(-1), { id: 'summary', kind: 'summary', text: 'Worked for 8s' });
});

test('finished reads, searches and shell commands fold into one summary line', () => {
  const tool = (id: string, name: string, status: 'done' | 'failed' | 'running' = 'done') => ({ id, kind: 'tool' as const, tool: name, text: `${name}(x)`, status });
  const folded = rows([tool('a', 'Read'), tool('b', 'Read'), tool('c', 'Grep'), tool('d', 'Bash'), tool('e', 'Read', 'failed'), tool('f', 'Glob'), tool('g', 'Read', 'running')]);
  assert.deepEqual(folded.map(row => row.kind === 'folded' ? row.entries.map(entry => entry.id).join('') : row.id), ['abcd', 'e', 'f', 'g']);
  const first = folded[0]!;
  assert.ok(first.kind === 'folded');
  assert.deepEqual(foldedSummary(first.entries), [{ verb: 'Read', count: 2, noun: 'files' }, { verb: 'searched for', count: 1, noun: 'pattern' }, { verb: 'ran', count: 1, noun: 'shell command' }]);
});

test('inline Markdown renders emphasis and code without literal markers', () => {
  assert.deepEqual(spans('Use **bold `x`** and `a*b*c`, *it* and [docs](https://d.e)'), [
    { text: 'Use ' }, { bold: true, text: 'bold ' }, { bold: true, code: true, text: 'x' }, { text: ' and ' }, { code: true, text: 'a*b*c' },
    { text: ', ' }, { italic: true, text: 'it' }, { text: ' and ' }, { text: 'docs' }, { dim: true, text: ' (https://d.e)' },
  ]);
  assert.deepEqual(spans('snake_case_name and 2 * 3 * 4'), [{ text: 'snake_case_name and 2 * 3 * 4' }]);
});

test('the spinner counts reported output tokens and estimates the streaming message', () => {
  let state = userTurn(emptyConversation(), 'Count');
  const event = (value: Record<string, unknown>) => { state = receiveFrame(state, { type: 'stream_event', event: value }); };
  event({ type: 'message_start', message: { id: 'one' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x'.repeat(40) } });
  event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'y'.repeat(40) } });
  assert.equal(turnTokens(state), 20);
  event({ type: 'message_delta', usage: { output_tokens: 31 } });
  assert.equal(turnTokens(state), 31, 'Reported usage replaces the estimate');
  event({ type: 'message_start', message: { id: 'two' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'z'.repeat(8) } });
  assert.equal(turnTokens(state), 33);
  state = receiveFrame(state, { type: 'result' });
  assert.equal(turnTokens(state), 0);
});

test('the detailed transcript shows complete tool output and wraps to the terminal', () => {
  const lines = transcriptLines([
    { id: 'u', kind: 'user', text: 'Run it' },
    { id: 't', kind: 'tool', tool: 'Bash', text: 'Bash(seq 3)', status: 'done', detail: '1\n… +2 lines', output: '1\n2\n3' },
    { id: 's', kind: 'summary', text: 'Worked for 1s' },
  ]);
  const text = (rows: { text: string }[][]) => rows.map(row => row.map(span => span.text).join(''));
  assert.deepEqual(text(lines), ['❯ Run it', '', '● Bash(seq 3)', '  ⎿  1', '     2', '     3', '', '✻ Worked for 1s', '']);
  assert.deepEqual(lines[2]![1], { text: 'Bash', bold: true });
  const markdown = transcriptLines([{ id: 'm', kind: 'text', text: '# Plan\nUse **bold** `code`' }]);
  assert.deepEqual(text(markdown), ['● Plan', '  Use bold code', '']);
  assert.ok(markdown[1]!.some(span => span.text === 'bold' && span.bold) && markdown[1]!.some(span => span.text === 'code' && span.code), 'The transcript renders Markdown');
  const wrapped = wrapLines([[{ text: 'ab' }, { text: 'cdef', bold: true }], [{ text: '🍈🍈🍈' }]], 4);
  assert.deepEqual(wrapped, [[{ text: 'ab' }, { text: 'cd', bold: true }], [{ text: 'ef', bold: true }], [{ text: '🍈🍈' }], [{ text: '🍈' }]]);
  assert.equal(rememberLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
    'Yes, and don’t ask again for Bash(npm test:*) for this session and switch to accept edits for this session');
});

test('streaming Markdown parses only its tail and matches the full render across fences', () => {
  const text = ['# Plan', 'Intro with **bold**', '```ts', 'const a = 1;', '~~~', '- not a list', '```', '', '> quoted *note*', '~~~~', 'raw ``` inside', '~~~~~', '- item `x`', '````', 'open fence', 'still code', ''].join('\n');
  // Every prefix as it streams in, so fences open, close and span the cut.
  for (let length = 0; length <= text.length; length++) {
    const prefix = text.slice(0, length);
    for (const count of [1, 2, 3, 5, 40]) assert.deepEqual(markdownTail(prefix, count), markdownRows(prefix).slice(-count), `${count} rows of ${JSON.stringify(prefix)}`);
  }
  // Unrelated text with a shared prefix cannot reuse another block's fence state.
  assert.deepEqual(markdownTail('```\ncode\n```\nplain', 1), [[{ text: 'plain' }]]);
  assert.deepEqual(markdownTail('```\ncode\nmore', 1), [[{ text: 'more', code: true }]]);
  assert.deepEqual(markdownTail('text', 0), []);

  const lines = (output: string) => output.split('\n');
  const entry = { id: 'm', kind: 'text' as const, text: Array.from({ length: 30 }, (_, i) => i === 12 ? '```' : `line ${i} ${'word '.repeat(i % 5)}`).join('\n') };
  const full = lines(renderToString(React.createElement(Entries, { entries: [entry] }), { columns: 30 }));
  const tail = lines(renderToString(React.createElement(Entries, { entries: [entry], tail: 8 }), { columns: 30 }));
  assert.deepEqual(tail.slice(-8), full.slice(-8), 'The visible bottom rows match the full render');
  assert.ok(tail.length < full.length, 'Hidden rows are not laid out');
});

test('transcript wrapping keeps wide and emoji graphemes intact and reuses unchanged entries', () => {
  const rows = [[{ text: 'ascii ' }, { text: '中文字', bold: true }, { text: '👩‍👩‍👧 é🍈x' }], [{ text: 'x'.repeat(9) }, { text: '' }, { text: 'yz', italic: true }], [{ text: 'tab\there' }], []];
  const wrapped = wrapLines(rows, 4);
  const text = (row: { text: string }[]) => row.map(span => span.text).join('');
  assert.deepEqual(wrapped.map(text), ['asci', 'i 中', '文字', '👩‍👩‍👧 é', '🍈x', 'xxxx', 'xxxx', 'xyz', 'tab\th', 'ere', '']);
  assert.ok(wrapped.every(row => stringWidth(text(row)) <= 4), 'Every row fits the width');
  assert.deepEqual(wrapped[7], [{ text: 'x' }, { text: 'yz', italic: true }]);
  assert.deepEqual(wrapLines([[{ text: 'abcdéfghijk' }]], 5).map(text), ['abcdé', 'fghij', 'k'], 'A combining mark stays with its ASCII base');
  assert.deepEqual(wrapLines([[{ text: 'abc' }]], 0),[[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]]);

  const entries = [
    { id: 'u', kind: 'user' as const, text: 'Show 🍈 output' },
    { id: 't', kind: 'tool' as const, tool: 'Bash', text: 'Bash(cat)', status: 'done' as const, output: `${'wide 中文 '.repeat(8)}\n${'plain '.repeat(20)}` },
  ];
  const first = transcriptRows(entries, 20);
  assert.deepEqual(first, wrapLines(transcriptLines(entries), 20));
  const changed = [entries[0]!, { ...entries[1]!, status: 'failed' as const }];
  const second = transcriptRows(changed, 20);
  assert.deepEqual(second, wrapLines(transcriptLines(changed), 20));
  assert.equal(second[0], first[0], 'An unchanged entry reuses its wrapped rows');
  assert.notEqual(transcriptRows(entries, 30)[0], first[0], 'A new width wraps again');
});
