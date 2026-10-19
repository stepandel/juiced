import { createHash } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { AgentJournalEntry, AgentJournalEvent, TerminalCommand } from '../protocol.js';

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

  private append(record: () => Record): Promise<void> {
    const next = this.pending.then(async () => {
      const value = record();
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      // Handle short writes before acknowledging persistence.
      for (let offset = 0; offset < bytes.length;) {
        const result = await this.file.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten) throw new Error('Agent journal write made no progress');
        offset += result.bytesWritten;
      }
      await this.file.sync();
      this.observe(value, this.size, bytes.length);
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
    let entry!: AgentJournalEntry;
    await this.append(() => ({ kind: 'event', entry: entry = { sequence: this.latest + 1, event } }));
    return entry;
  }

  async page(after: number) {
    await this.pending;
    if (!Number.isSafeInteger(after) || after < 0 || after > this.latest) throw new Error('Invalid agent history cursor');
    const entries: AgentJournalEntry[] = [];
    let size = 0;
    const latest = this.latest;
    for (let index = after; index < latest; index++) {
      const position = this.positions[index]!;
      if (size + position.bytes > 48 * 1024 && entries.length) break;
      const bytes = Buffer.alloc(position.bytes);
      for (let offset = 0; offset < bytes.length;) {
        const result = await this.file.read(bytes, offset, bytes.length - offset, position.offset + offset);
        if (!result.bytesRead) throw new Error('Agent history is incomplete');
        offset += result.bytesRead;
      }
      entries.push((JSON.parse(bytes.toString()) as Extract<Record, { kind: 'event' }>).entry);
      size += bytes.length;
    }
    return { entries, latest };
  }
}
