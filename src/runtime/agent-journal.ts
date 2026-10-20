import { createHash } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { AgentJournalEntry, AgentJournalEvent, TerminalCommand } from '../protocol.js';
import { saveSessionIdentity } from './session-list.js';

type Record = { kind: 'event'; entry: AgentJournalEntry }
  | { kind: 'conversation'; id: string }
  | { kind: 'configuration'; command: Extract<TerminalCommand, { type: 'start' }> }
  | { kind: 'checkpoint' }
  | { kind: 'input'; id: string; hash: string; epoch: string; delivered: boolean };

/** The workspace owns the history. Transport replay is only a delivery cache. */
export class AgentJournal {
  private file!: FileHandle;
  private size = 0;
  private positions: Array<{ offset: number; bytes: number }> = [];
  private pending = Promise.resolve();
  private opening?: Promise<void>;
  conversation = '';
  configuration: Extract<TerminalCommand, { type: 'start' }> | undefined;
  resumable = false;
  state: 'ready' | 'working' | 'sleeping' | 'interrupted' = 'sleeping';
  readonly inputs = new Map<string, Extract<Record, { kind: 'input' }>>();

  constructor(private workspace: string, private session: string) {}
  get latest() { return this.positions.length; }

  open(): Promise<void> {
    return this.opening ??= (async () => {
      const directory = join(this.workspace, '.juiced', 'sessions', createHash('sha256').update(this.session).digest('hex'));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'events.jsonl');
      this.file = await open(path, 'a+', 0o600);
      for (const directoryPath of [directory, dirname(directory), dirname(dirname(directory)), this.workspace]) {
        const directoryFile = await open(directoryPath, 'r');
        try { await directoryFile.sync(); } finally { await directoryFile.close(); }
      }
      let offset = 0;
      // Ignore only an incomplete final append. Malformed committed records fail closed.
      const length = (await this.file.stat()).size;
      const lines = createInterface({ input: this.file.createReadStream({ start: 0, autoClose: false }), crlfDelay: Infinity });
      for await (const line of lines) {
        const bytes = Buffer.byteLength(line) + 1;
        if (offset + bytes > length) break;
        const record = JSON.parse(line) as Record;
        this.observe(record, offset, bytes);
        offset += bytes;
      }
      if (offset !== length) { await this.file.truncate(offset); await this.file.sync(); }
      this.size = offset;
      await saveSessionIdentity(directory, this.session);
    })();
  }

  private observe(record: Record, offset: number, bytes: number) {
    if (record.kind === 'conversation') this.conversation = record.id;
    else if (record.kind === 'configuration') this.configuration = record.command;
    else if (record.kind === 'checkpoint') this.resumable = true;
    else if (record.kind === 'input') this.inputs.set(record.id, record);
    else if (record.kind === 'event') {
      if (record.entry.sequence !== this.positions.length + 1) throw new Error('Invalid agent journal sequence');
      this.positions.push({ offset, bytes });
      if (record.entry.event.type === 'state') this.state = record.entry.event.state;
      if (record.entry.event.type === 'reset') this.state = 'ready';
    } else throw new Error('Invalid agent journal record');
  }

  private append(record: () => Record | Record[]): Promise<void> {
    const next = this.pending.then(async () => {
      const value = record();
      const records = Array.isArray(value) ? value : [value];
      const lines = records.map(record => Buffer.from(JSON.stringify(record) + '\n'));
      const bytes = Buffer.concat(lines);
      // Handle short writes before acknowledging persistence.
      for (let offset = 0; offset < bytes.length;) {
        const result = await this.file.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten) throw new Error('Agent journal write made no progress');
        offset += result.bytesWritten;
      }
      await this.file.sync();
      let offset = this.size;
      records.forEach((record, index) => {
        this.observe(record, offset, lines[index]!.length);
        offset += lines[index]!.length;
      });
      this.size += bytes.length;
    });
    this.pending = next;
    return next;
  }

  async setConversation(id: string) { await this.append(() => ({ kind: 'conversation', id })); }
  async configure(command: Extract<TerminalCommand, { type: 'start' }>) { await this.append(() => ({ kind: 'configuration', command })); }
  async checkpoint() { if (!this.resumable) await this.append(() => ({ kind: 'checkpoint' })); }
  async close() { await this.pending.catch(() => {}); await this.file?.close(); }
  async input(id: string, hash: string, epoch: string, delivered: boolean) {
    await this.append(() => ({ kind: 'input', id, hash, epoch, delivered }));
  }
  async event(event: AgentJournalEvent): Promise<AgentJournalEntry> {
    return (await this.events([event]))[0]!;
  }

  async events(events: AgentJournalEvent[]): Promise<AgentJournalEntry[]> {
    if (!events.length) return [];
    let entries!: AgentJournalEntry[];
    await this.append(() => {
      entries = events.map((event, index) => ({ sequence: this.latest + index + 1, event }));
      return entries.map(entry => ({ kind: 'event', entry }));
    });
    return entries;
  }

  async page(after: number, through?: number) {
    await this.pending;
    const latest = through ?? this.latest;
    if (!Number.isSafeInteger(after) || after < 0 || after > latest || !Number.isSafeInteger(latest) || latest > this.latest) throw new Error('Invalid agent history cursor');
    let end = after, size = 0;
    for (; end < latest; end++) {
      const position = this.positions[end]!;
      if (size + position.bytes > 48 * 1024 && end > after) break;
      size += position.bytes;
    }
    if (end === after) return { entries: [], latest };
    // One read spans the page; interleaved non-event records are small and skipped by position.
    const start = this.positions[after]!.offset, last = this.positions[end - 1]!;
    const bytes = Buffer.alloc(last.offset + last.bytes - start);
    for (let offset = 0; offset < bytes.length;) {
      const result = await this.file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!result.bytesRead) throw new Error('Agent history is incomplete');
      offset += result.bytesRead;
    }
    const entries = this.positions.slice(after, end).map(position =>
      (JSON.parse(bytes.toString('utf8', position.offset - start, position.offset - start + position.bytes)) as Extract<Record, { kind: 'event' }>).entry);
    return { entries, latest };
  }
}
