import type { GitCommand, GitEvent, GitResult, StaleLease } from './git-protocol.js';
import type { InspectionCommand, InspectionEvent, InspectionListing, InspectionSnapshot } from './inspection-protocol.js';
import type { SavedSettings } from './settings.js';
import type { ClaudeFrame } from './agent-protocol.js';
import type { SessionListCommand, SessionListPage } from './session-list-protocol.js';
import type { Publication, PublishCommand, PublishResult, UploadRequest } from './publish-protocol.js';

export type AgentJournalEvent =
  | { type: 'bytes'; channel: 'stdout' | 'stderr'; data: string }
  | { type: 'user'; id: string; data: string; final: boolean }
  | { type: 'approval-answer'; id: string }
  | { type: 'local-publish'; publication: Publication }
  | { type: 'local-upload'; request: UploadRequest }
  | { type: 'local-publish-done'; id: string }
  | { type: 'reset'; epoch: string; interrupted: boolean }
  | { type: 'state'; state: 'ready' | 'working' | 'sleeping' | 'interrupted' };
export type AgentJournalEntry = { sequence: number; event: AgentJournalEvent };
export type AgentConnection = { epoch: string; initialized?: ClaudeFrame };

export type TerminalCommand =
  | { type: 'start'; argv: string[]; tty: boolean; columns: number; rows: number; term: string; directoryName?: string; git?: { binding: string; relativeDirectory: string }; durable?: boolean; localPublish?: string }
  | { type: 'agent-input'; id: string; epoch: string; frame: ClaudeFrame }
  | { type: 'agent-replay'; after: number; stream?: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' }
  | { type: 'eof' }
  | { type: 'heartbeat' }
  | { type: 'save-settings'; settings: SavedSettings }
  | GitCommand
  | SessionListCommand
  | PublishCommand
  | InspectionCommand;

export type TerminalEvent =
  | ({ type: 'agent-output' } & AgentJournalEntry)
  | { type: 'agent-replay'; id: string; entries: AgentJournalEntry[] }
  | { type: 'agent-replay-end'; id: string; latest: number; error?: string }
  | { type: 'ready' }
  | { type: 'output'; channel: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'local-publish'; publication: Publication }
  | { type: 'local-upload'; request: UploadRequest }
  | { type: 'local-publish-done'; id: string }
  | GitEvent
  | InspectionEvent;

export type TerminalReply = { ok: true; git?: GitResult; agent?: AgentConnection; replay?: { entries: AgentJournalEntry[]; latest: number }; sessions?: SessionListPage; publication?: PublishResult; inspection?: InspectionSnapshot | InspectionListing } | { ok: false; error: string; stale?: StaleLease[]; busy?: 'sessions' | 'maintenance' };

export const MAX_INPUT_BYTES = 16 * 1024;
export const MAX_BUFFERED_INPUT = 1024 * 1024;
/** Raw bytes per output/journal event; base64 keeps each event near 16 KiB. */
export const OUTPUT_CHUNK_BYTES = 12 * 1024;
/** One serialized durable agent-input frame, newline included. */
export const MAX_AGENT_INPUT_BYTES = 768 * 1024;
/** One submitted prompt, before framing. */
export const MAX_PROMPT_BYTES = 512 * 1024;
/** Canonical padded base64, as Buffer#toString('base64') produces. */
export const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const validWorkspaceId = (id: unknown): id is string => typeof id === 'string' && /^wsp_[a-f0-9]{32}$/.test(id);

export function dimensions(columns: number, rows: number): void {
  if (!Number.isInteger(columns) || columns < 1 || columns > 1000 ||
      !Number.isInteger(rows) || rows < 1 || rows > 500) {
    throw new Error('Invalid terminal dimensions');
  }
}

export function decodeInput(data: string): Buffer {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 ||
      !BASE64.test(data)) {
    throw new Error('Invalid terminal input');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('Terminal input is too large');
  return bytes;
}
