import { stripVTControlCharacters } from 'node:util';
import { object, type ClaudeFrame } from '../agent-protocol.js';

/** `tool` is the native tool name; `detail` is the summary printed under a tool call. */
export type Entry = { id: string; kind: 'user' | 'text' | 'tool' | 'notice' | 'summary'; text: string; tool?: string; detail?: string; status?: 'running' | 'done' | 'failed' };
export type Turn = { id: number; entries: Entry[] };
export type Conversation = { history: Turn[]; live: Entry[]; printed: Entry[]; streamId: string; streamIndex: number | null; model: string; turn: number; tokens: number };
export const emptyConversation = (): Conversation => ({ history: [], live: [], printed: [], streamId: '', streamIndex: null, model: '', turn: 0, tokens: 0 });
export const plain = (text: unknown) => stripVTControlCharacters(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const bounded = (text: string) => text.length > 512 * 1024 ? text.slice(0, 512 * 1024) + '\n[display truncated]' : text;
const line = (value: unknown) => plain(value).replace(/\s+/g, ' ').trim();
const clip = (text: string, length: number) => text.length > length ? text.slice(0, length - 1) + '…' : text;
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const relative = (path: unknown) => line(path).replace(/^\/workspace\//u, '');
const lineCount = (text: unknown) => typeof text === 'string' && text ? text.replace(/\n$/u, '').split('\n').length : 0;

/** Native tool names and arguments, as Claude Code prints them: `Bash(pwd)`. */
export function toolSummary(name: unknown, value: unknown): string {
  const input = object(value);
  const tool = plain(name);
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(tool);
  const pairs = (keys: string[]) => keys.filter(key => input[key] !== undefined && input[key] !== '').map(key => `${key}: ${JSON.stringify(typeof input[key] === 'string' ? line(input[key]) : input[key])}`).join(', ');
  const call = (label: string, args: string) => `${label}(${clip(args, 160)})`;
  if (mcp) return call(`${mcp[1]} - ${mcp[2]} (MCP)`, pairs(Object.keys(input).filter(key => ['string', 'number', 'boolean'].includes(typeof input[key]))));
  switch (tool) {
    case 'Bash': return call('Bash', line(input.command));
    case 'Read': case 'Write': case 'NotebookEdit': return call(tool, relative(input.file_path ?? input.notebook_path));
    case 'Edit': case 'MultiEdit': return call('Update', relative(input.file_path));
    case 'Grep': return call('Search', pairs(['pattern', 'path', 'glob']));
    case 'Glob': return call('Search', pairs(['pattern', 'path']));
    case 'LS': return call('List', relative(input.path));
    case 'WebFetch': return call('Fetch', line(input.url));
    case 'WebSearch': return call('Web Search', JSON.stringify(line(input.query)));
    case 'Task': case 'Agent': return call(tool, line(input.description ?? input.prompt));
    case 'TodoWrite': return 'Update Todos';
    default: return call(tool, line(input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description ?? input.url ?? ''));
  }
}

/** A summary known from the call itself: line counts for edits, the todo list. */
function inputDetail(name: unknown, value: unknown): string | undefined {
  const input = object(value);
  if (name === 'Write') return `Wrote ${plural(lineCount(input.content), 'line')} to ${relative(input.file_path)}`;
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits.map(object) : [];
    const added = edits.reduce((sum, item) => sum + lineCount(item.new_string), 0);
    const removed = edits.reduce((sum, item) => sum + lineCount(item.old_string), 0);
    return `Updated ${relative(input.file_path)} with ${plural(added, 'addition')} and ${plural(removed, 'removal')}`;
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.map(object).map(todo => `${todo.status === 'completed' ? '☒' : todo.status === 'in_progress' ? '◼' : '☐'} ${line(todo.content)}`).join('\n').slice(0, 4000) || undefined;
  }
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return plain(content.replace(/\r\n?/gu, '\n'));
  if (Array.isArray(content)) return content.map(object).map(block => block.type === 'text' ? resultText(block.text) : block.type === 'image' ? '[Image]' : '').filter(Boolean).join('\n');
  return '';
}

/** Claude Code shows a few lines of output and counts the remainder. */
export function preview(text: string, rows = 3): string {
  const lines = text.replace(/\n+$/u, '').split('\n');
  if (lines.length <= rows) return lines.join('\n');
  return [...lines.slice(0, rows), `… +${plural(lines.length - rows, 'line')}`].join('\n');
}

/** The `⎿` line under a completed tool call. */
export function toolResult(entry: Entry, content: unknown, failed: boolean): string {
  const text = resultText(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, '').trim().slice(0, 64 * 1024);
  if (failed) {
    if (/doesn.t want to (proceed|take this action)|rejected|denied/iu.test(text)) return 'User rejected this tool use';
    return preview(text || 'Error');
  }
  if (entry.detail) return entry.detail;
  const lines = text ? text.split('\n') : [];
  switch (entry.tool) {
    case 'Read': return `Read ${plural(lines.filter(item => /^\s*\d+[\t→]/u.test(item)).length || lines.length, 'line')}`;
    case 'Grep': case 'Glob': {
      if (/^(No files found|No matches found|Found \d+)/u.test(text)) return lines[0]!;
      return `Found ${plural(lines.filter(Boolean).length, entry.tool === 'Glob' ? 'file' : 'line')}`;
    }
    case 'LS': return `Listed ${plural(Math.max(0, lines.filter(Boolean).length - 1), 'path')}`;
    default: return text ? preview(text) : '(No content)';
  }
}

const verbs = ['Worked', 'Brewed', 'Cooked', 'Churned', 'Crunched', 'Cogitated', 'Baked', 'Sautéed', 'Simmered', 'Juiced'];
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function userTurn(state: Conversation, text: string): Conversation {
  return { ...state, live: [{ id: `user-${state.turn}`, kind: 'user', text: plain(text) }], printed: [], streamId: '', streamIndex: null };
}

/** Keep replayed output in scrollback while reconciling later native snapshots. */
export function liveEntries(state: Conversation): Entry[] {
  const printed = new Map(state.printed.map(entry => [entry.id, entry]));
  return state.live.flatMap(entry => {
    const previous = printed.get(entry.id);
    if (!previous) return [entry];
    if (entry.text === previous.text && entry.status === previous.status) return [];
    // A reattachment can land in the middle of a streamed text block.
    if (entry.kind === 'text' && entry.text.startsWith(previous.text)) return [{ ...entry, text: entry.text.slice(previous.text.length) }];
    return [entry];
  });
}

export function restoreHistory(state: Conversation): Conversation {
  const entries = liveEntries(state);
  if (!entries.length) return state;
  return { ...state, history: [...state.history, { id: state.history.length, entries }], printed: state.live };
}

function toolEntry(block: ClaudeFrame, live: Entry[]): Entry {
  const previous = live.find(item => item.id === block.id);
  const detail = inputDetail(block.name, block.input) ?? previous?.detail;
  return { id: String(block.id), kind: 'tool', tool: plain(block.name), text: toolSummary(block.name, block.input), status: previous?.status ?? 'running', ...(detail ? { detail } : {}) };
}

/** Partial events and final assistant snapshots describe the same blocks. */
export function receiveFrame(state: Conversation, frame: ClaudeFrame): Conversation {
  if (frame.type === 'juiced_user' && typeof frame.text === 'string') {
    if (state.live.some(entry => entry.kind === 'user' && entry.text === plain(frame.text))) return state;
    return userTurn(state, frame.text);
  }
  let live = [...state.live];
  let streamIndex = state.streamIndex;
  const put = (entry: Entry) => {
    const index = live.findIndex(item => item.id === entry.id);
    if (index === -1) live.push(entry); else live[index] = entry;
  };
  if (frame.type === 'system' && frame.subtype === 'init') return { ...state, model: plain(frame.model) };
  if (frame.type === 'juiced_publish') put({ id: `publish-${frame.id}`, kind: 'notice', text: plain(frame.message), status: frame.failed ? 'failed' : 'done' });
  if (frame.type === 'system' && frame.subtype === 'api_retry') {
    put({ id: 'retry', kind: 'notice', text: `Claude is retrying (${frame.attempt ?? '?'})…` });
  }
  if (frame.type === 'stream_event' && !frame.parent_tool_use_id) {
    const event = object(frame.event);
    if (event.type === 'message_start') return { ...state, streamId: String(object(event.message).id ?? frame.uuid), streamIndex: null };
    const id = `${state.streamId}:${event.index}`;
    if (event.type === 'content_block_start' || event.type === 'content_block_delta') streamIndex = Number(event.index);
    if (event.type === 'content_block_stop' || event.type === 'message_stop') streamIndex = null;
    if (event.type === 'content_block_start') {
      const block = object(event.content_block);
      if (block.type === 'text') put({ id, kind: 'text', text: plain(block.text) });
      if (block.type === 'tool_use') put(toolEntry(block, live));
    }
    if (event.type === 'content_block_delta') {
      const delta = object(event.delta);
      if (delta.type === 'text_delta') put({ id, kind: 'text', text: bounded((live.find(item => item.id === id)?.text ?? '') + plain(delta.text)) });
    }
  }
  if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
    const message = object(frame.message);
    const content = message.content;
    if (Array.isArray(content)) content.forEach((raw, index) => {
      const block = object(raw);
      if (block.type === 'text') {
        const text = bounded(plain(block.text));
        // Claude emits each completed block separately, before content_block_stop.
        // Its one-item content array does not retain the block's stream index.
        const blockIndex = content.length === 1 && streamIndex !== null ? streamIndex : index;
        const streamed = live.find(entry => entry.id === `${state.streamId}:${blockIndex}` && entry.kind === 'text');
        // Interrupted CLI turns can give the final snapshot a new message ID.
        const sameBlock = message.id === state.streamId || streamIndex !== null && streamed?.text.trimEnd() === text.trimEnd();
        const id = streamed && sameBlock ? streamed.id : `${message.id}:${index}`;
        put({ id, kind: 'text', text });
      }
      if (block.type === 'tool_use') put(toolEntry(block, live));
    });
  }
  if (frame.type === 'user') {
    const message = object(frame.message);
    if (Array.isArray(message.content)) for (const raw of message.content) {
      const block = object(raw);
      if (block.type !== 'tool_result') continue;
      const item = live.find(entry => entry.id === block.tool_use_id);
      if (item) put({ ...item, status: block.is_error ? 'failed' : 'done', detail: toolResult(item, block.content, Boolean(block.is_error)) });
    }
  }
  if (frame.type === 'result') {
    if (!live.some(item => item.kind === 'text') && frame.result) put({ id: 'result', kind: 'text', text: bounded(plain(frame.result)) });
    if (frame.juiced_interrupted) put({ id: 'interrupted', kind: 'notice', text: 'Interrupted' });
    else if (frame.is_error) put({ id: 'error', kind: 'notice', text: plain(Array.isArray(frame.errors) ? frame.errors.join('\n') : frame.result ?? 'The Claude turn failed') });
    live = live.map(entry => entry.status === 'running' ? { ...entry, status: frame.is_error ? 'failed' : 'done' } : entry);
    if (!frame.juiced_interrupted && !frame.is_error && typeof frame.duration_ms === 'number') put({ id: 'summary', kind: 'summary', text: `${verbs[state.turn % verbs.length]} for ${duration(frame.duration_ms)}` });
    const tokens = Number(object(frame.usage).input_tokens ?? 0) + Number(object(frame.usage).output_tokens ?? 0);
    const entries = liveEntries({ ...state, live });
    return { ...state, history: [...state.history, { id: state.history.length, entries }], live: [], printed: [], streamId: '', streamIndex: null, turn: state.turn + 1, tokens };
  }
  return { ...state, live, streamIndex };
}
