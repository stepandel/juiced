import { stripVTControlCharacters } from 'node:util';
import { object, type ClaudeFrame } from '../agent-protocol.js';

export type Entry = { id: string; kind: 'user' | 'text' | 'tool' | 'notice'; text: string; detail?: string; status?: 'running' | 'done' | 'failed' };
export type Turn = { id: number; entries: Entry[] };
export type Conversation = { history: Turn[]; live: Entry[]; streamId: string; streamIndex: number | null; model: string; turn: number; tokens: number };
export const emptyConversation = (): Conversation => ({ history: [], live: [], streamId: '', streamIndex: null, model: '', turn: 0, tokens: 0 });
export const plain = (text: unknown) => stripVTControlCharacters(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const bounded = (text: string) => text.length > 512 * 1024 ? text.slice(0, 512 * 1024) + '\n[display truncated]' : text;
export function toolSummary(name: unknown, value: unknown): string {
  const input = object(value);
  return plain(`${String(name)}  ${input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description ?? ''}`).replace(/\s+/g, ' ').slice(0, 240);
}

export function userTurn(state: Conversation, text: string): Conversation {
  return { ...state, live: [{ id: `user-${state.turn}`, kind: 'user', text: plain(text) }], streamId: '', streamIndex: null };
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
      if (block.type === 'tool_use') put({ id: String(block.id), kind: 'tool', text: toolSummary(block.name, block.input), status: 'running' });
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
      if (block.type === 'tool_use') put({ id: String(block.id), kind: 'tool', text: toolSummary(block.name, block.input), status: live.find(item => item.id === block.id)?.status ?? 'running' });
    });
  }
  if (frame.type === 'user') {
    const message = object(frame.message);
    if (Array.isArray(message.content)) for (const raw of message.content) {
      const block = object(raw);
      if (block.type !== 'tool_result') continue;
      const item = live.find(entry => entry.id === block.tool_use_id);
      if (item) put({ ...item, status: block.is_error ? 'failed' : 'done' });
    }
  }
  if (frame.type === 'result') {
    if (!live.some(item => item.kind === 'text') && frame.result) put({ id: 'result', kind: 'text', text: bounded(plain(frame.result)) });
    if (frame.juiced_interrupted) put({ id: 'interrupted', kind: 'notice', text: 'Interrupted' });
    else if (frame.is_error) put({ id: 'error', kind: 'notice', text: plain(Array.isArray(frame.errors) ? frame.errors.join('\n') : frame.result ?? 'The Claude turn failed') });
    live = live.map(entry => entry.status === 'running' ? { ...entry, status: frame.is_error ? 'failed' : 'done' } : entry);
    const tokens = Number(object(frame.usage).input_tokens ?? 0) + Number(object(frame.usage).output_tokens ?? 0);
    return { ...state, history: [...state.history, { id: state.turn, entries: live }], live: [], streamId: '', streamIndex: null, turn: state.turn + 1, tokens };
  }
  return { ...state, live, streamIndex };
}
