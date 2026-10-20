import { ClaudeDecoder, object, type Approval, type ClaudeFrame } from './agent-protocol.js';
import type { AgentJournalEntry, AgentSnapshot } from './protocol.js';
import { emptyConversation, receiveFrame, type Conversation, type Entry } from './tui/conversation.js';
import { observeAgentMetadata } from './agent-metadata.js';

// Leave room for the view envelope below the platform's 64 KiB event limit.
export const MAX_AGENT_SNAPSHOT_BYTES = 60 * 1024;
const text = (value: string, limit = 4096) => {
  if (value.length <= limit) return value;
  const end = limit - 1, last = value.charCodeAt(end - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end) + '…';
};
const compact = (entries: Entry[]) => entries.slice(-12).map(entry => ({ ...entry, text: text(entry.text) }));

/** A small display projection; the journal and native transcript retain full history. */
export class AgentSnapshotProjection {
  private decoder = new ClaudeDecoder();
  private boundary = true;
  private users = new Map<string, Buffer[]>();
  private approvals = new Map<string, Approval>();
  private unsupported = new Set<string>();
  private info: ClaudeFrame = {};
  private tasks = new Map<string, ClaudeFrame>();
  private conversation = emptyConversation();
  private epoch = '';
  private state: AgentSnapshot['state'] = 'sleeping';
  private saved: AgentSnapshot | undefined;

  private frame(frame: ClaudeFrame) {
    observeAgentMetadata(this.info, this.tasks, frame);
    this.conversation = receiveFrame(this.conversation, frame);
    this.conversation.history = this.conversation.history.slice(-1);
    this.conversation.live = this.conversation.live.slice(-12);
    if (frame.type === 'control_request' && object(frame.request).subtype === 'can_use_tool') {
      const request = object(frame.request), id = String(frame.request_id);
      this.approvals.set(id, { id, tool: String(request.tool_name), input: object(request.input), description: String(request.description ?? request.decision_reason ?? '') });
    } else if (frame.type === 'control_request') this.unsupported.add(String(frame.request_id));
    else if (frame.type === 'control_cancel_request') {
      this.approvals.delete(String(frame.request_id)); this.unsupported.delete(String(frame.request_id));
    } else if (frame.type === 'result') { this.approvals.clear(); this.unsupported.clear(); }
  }

  observe(entry: AgentJournalEntry) {
    const event = entry.event;
    if (event.type === 'bytes' && event.channel === 'stdout') {
      const bytes = Buffer.from(event.data, 'base64');
      for (const frame of this.decoder.push(bytes)) this.frame(frame);
      // A snapshot never skips a partially decoded JSON/UTF-8 frame.
      this.boundary = bytes.at(-1) === 10;
    } else if (event.type === 'user') {
      const chunks = this.users.get(event.id) ?? [];
      chunks.push(Buffer.from(event.data, 'base64'));
      if (event.final) {
        this.users.delete(event.id);
        this.frame({ type: 'juiced_user', text: Buffer.concat(chunks).toString() });
      } else this.users.set(event.id, chunks);
    } else if (event.type === 'approval-answer') { this.approvals.delete(event.id); this.unsupported.delete(event.id); }
    else if (event.type === 'state') this.state = event.state;
    else if (event.type === 'reset') {
      this.epoch = event.epoch;
      this.state = 'ready';
      this.decoder = new ClaudeDecoder(); this.boundary = true;
      this.users.clear(); this.approvals.clear(); this.unsupported.clear();
      if (event.interrupted) this.frame({ type: 'result', juiced_interrupted: true, result: 'The remote process stopped. Saved output was recovered; the interrupted prompt was not resubmitted.' });
    }
    // The client must still reject an unknown native control request explicitly.
    if (this.unsupported.size) { this.saved = undefined; return; }
    if (!this.boundary || this.users.size) return;
    const conversation: Conversation = { ...this.conversation, printed: [], live: compact(this.conversation.live),
      history: this.conversation.history.map(turn => ({ ...turn, entries: compact(turn.entries) })) };
    const snapshot: AgentSnapshot = { version: 1, sequence: entry.sequence, epoch: this.epoch, state: this.state, conversation, approvals: [...this.approvals.values()], info: { ...this.info }, tasks: [...this.tasks.values()] };
    // Display text can shrink. Permission payloads must remain exact.
    while (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_AGENT_SNAPSHOT_BYTES) {
      const entries = conversation.history[0]?.entries;
      if (entries?.length && (conversation.live.length || entries.length > 1)) entries.shift();
      else if (conversation.live.length > 1) conversation.live.shift();
      else {
        const last = conversation.live[0] ?? entries?.[0];
        if (!last || last.text.length < 64) { this.saved = undefined; return; }
        last.text = text(last.text, Math.floor(last.text.length / 2));
      }
    }
    this.saved = snapshot;
  }

  view(agentSequence: number) {
    return { agentSequence, ...(this.saved ? { snapshot: this.saved } : {}) };
  }
}

/** Unknown/old views fall back to journal recovery instead of losing state. */
export function readAgentSnapshot(value: unknown): AgentSnapshot | undefined {
  const snapshot = object(value), conversation = object(snapshot.conversation);
  const entry = (value: unknown) => {
    const item = object(value);
    return typeof item.id === 'string' && typeof item.text === 'string' && ['user', 'text', 'tool', 'notice'].includes(String(item.kind))
      && (item.status === undefined || ['running', 'done', 'failed'].includes(String(item.status)));
  };
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.sequence) || Number(snapshot.sequence) < 0 || typeof snapshot.epoch !== 'string'
    || !['ready', 'working', 'sleeping', 'interrupted'].includes(String(snapshot.state))
    || !Array.isArray(snapshot.approvals) || !snapshot.approvals.every(value => {
      const approval = object(value);
      return typeof approval.id === 'string' && typeof approval.tool === 'string' && approval.input !== null && typeof approval.input === 'object' && !Array.isArray(approval.input) && typeof approval.description === 'string';
    })
    || !snapshot.info || typeof snapshot.info !== 'object' || Array.isArray(snapshot.info)
    || !Array.isArray(snapshot.tasks) || !snapshot.tasks.every(value => typeof object(value).task_id === 'string')
    || !Array.isArray(conversation.live) || !conversation.live.every(entry)
    || !Array.isArray(conversation.history) || !conversation.history.every(value => {
      const turn = object(value);
      return Number.isSafeInteger(turn.id) && Array.isArray(turn.entries) && turn.entries.every(entry);
    })
    || !Array.isArray(conversation.printed) || !conversation.printed.every(entry)
    || typeof conversation.streamId !== 'string' || !(conversation.streamIndex === null || Number.isSafeInteger(conversation.streamIndex))
    || typeof conversation.model !== 'string' || !Number.isSafeInteger(conversation.turn) || !Number.isFinite(conversation.tokens)
    || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_AGENT_SNAPSHOT_BYTES) return undefined;
  return snapshot as AgentSnapshot;
}
