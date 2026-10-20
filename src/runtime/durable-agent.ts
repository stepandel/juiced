import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionContext, SessionHarnessContext, SessionOutput } from '@cantelop/sdk/session';
import { ClaudeDecoder, object, type ClaudeFrame } from '../agent-protocol.js';
import { MAX_INPUT_BYTES, type AgentJournalEvent, type AgentJournalEntry, type TerminalCommand, type TerminalEvent, type TerminalReply } from '../protocol.js';
import { selectsClaudeSession } from '../terminal-session.js';
import { AgentJournal } from './agent-journal.js';
import type { createTerminal } from './terminal.js';

type Context = SessionContext<TerminalCommand, TerminalEvent, TerminalReply>;
type Start = Extract<TerminalCommand, { type: 'start' }>;
const RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 120_000;
const TEXT_BATCH_MS = 25;
const PUBLICATION_WINDOW = 12;

async function transcriptExists(workspace: string, id: string) {
  const root = join(workspace, '.claude', 'projects');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  for (const entry of entries) if (entry.isDirectory()) {
    try { if ((await stat(join(root, entry.name, `${id}.jsonl`))).size) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}

/** Keep native menus and approvals while making process lifetime and output server-owned. */
export function createDurableAgent(context: SessionHarnessContext, factory: () => ReturnType<typeof createTerminal>, workspace = process.cwd(), options: { idleTimeoutMs?: number; runTimeoutMs?: number } = {}) {
  const journal = new AgentJournal(workspace, context.session.id);
  let loading: Promise<void> | undefined;
  let terminal: ReturnType<typeof createTerminal> | undefined;
  let running: Promise<void> | undefined;
  let epoch = '';
  let initialized: ClaudeFrame | undefined;
  let turn = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let decoder = new ClaudeDecoder();
  let buffered: ClaudeFrame[] = [];
  let bufferedBytes = 0;
  let firstDelta = true;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = Promise.resolve();
  const controls = new Map<string, string>();
  let sink: SessionOutput<TerminalEvent> | undefined;
  let view: Context['view'] | undefined;
  let outputSignal: AbortSignal = context.signal;
  let publication: Promise<void> | undefined;
  let publicationAfter: number | undefined;
  let publicationThrough = 0;
  let publicationVersion = 0;
  let publicationWake: (() => void) | undefined;
  let stopping = false;

  const load = () => loading ??= (async () => {
    await journal.open();
    if (journal.state === 'working' || journal.state === 'ready') {
      await journal.event({ type: 'reset', epoch: '', interrupted: journal.state === 'working' });
      await journal.event({ type: 'state', state: 'sleeping' });
    }
  })();

  function publish(entry: AgentJournalEntry) {
    publicationAfter ??= entry.sequence - 1;
    publicationThrough = entry.sequence;
    wakePublication();
    startPublication();
  }
  function wakePublication() {
    publicationVersion++;
    publicationWake?.();
    publicationWake = undefined;
  }
  function startPublication() {
    // Drain from disk rather than dropping notifications while an acknowledgment
    // is pending. Only one bounded window of journal entries lives in memory.
    publication ??= (async () => {
      type Handoff = { sequence: number; done: boolean; failed: boolean; settled: Promise<void> };
      const track = (sequence: number, work: Promise<void>): Handoff => {
        const item: Handoff = { sequence, done: false, failed: false, settled: Promise.resolve() };
        item.settled = work.then(() => { item.done = true; }, () => { item.failed = true; }).then(wakePublication);
        return item;
      };
      const pending: Handoff[] = [];
      let projection: Handoff | undefined;
      let after = publicationAfter!;
      let viewed = after;
      const acknowledged = () => {
        while (pending[0]?.done) publicationAfter = pending.shift()!.sequence;
        if (projection?.done) { viewed = projection.sequence; projection = undefined; }
      };
      while (sink && !outputSignal.aborted) {
        const version = publicationVersion;
        try {
          acknowledged();
          if (pending.some(item => item.failed) || projection?.failed) throw new Error('Agent output handoff failed');
          while (pending.length < PUBLICATION_WINDOW && after < publicationThrough) {
            const page = await journal.page(after, publicationThrough);
            for (const entry of page.entries) {
              pending.push(track(entry.sequence, sink.send({ type: 'agent-output', ...entry })));
              after = entry.sequence;
              if (pending.length === PUBLICATION_WINDOW) break;
            }
          }
          // A single coalesced view follows its enqueued events. Waiting for it
          // never prevents another output event from filling an available slot.
          if (!projection && view && after > viewed) projection = track(after, view.commit({ agentSequence: after }));
          if (!pending.length && !projection && after === publicationThrough) break;
          // New appends can fill a partially occupied window before its first
          // acknowledgment. The version check prevents a lost wake during reads.
          if (version === publicationVersion) await new Promise<void>(resolve => { publicationWake = resolve; });
        }
        catch {
          await Promise.all(pending.map(item => item.settled).concat(projection ? [projection.settled] : []));
          acknowledged();
          pending.length = 0; projection = undefined;
          after = publicationAfter!; viewed = Math.min(viewed, after);
          if (outputSignal.aborted) break;
          await delay(1000, undefined, { signal: outputSignal }).catch(() => {});
        }
      }
    })().finally(() => {
      publication = undefined;
      publicationWake = undefined;
      // A journal append can complete between the last loop check and finally.
      if (sink && !outputSignal.aborted && publicationAfter! < publicationThrough) startPublication();
    });
  }
  async function record(event: AgentJournalEvent) {
    const entry = await journal.event(event);
    if (sink) publish(entry);
  }
  async function bytes(channel: 'stdout' | 'stderr', bytes: Buffer) {
    const events: AgentJournalEvent[] = [];
    for (let offset = 0; offset < bytes.length; offset += 12 * 1024)
      events.push({ type: 'bytes', channel, data: bytes.subarray(offset, offset + 12 * 1024).toString('base64') });
    // One fsync per native output batch, including all of its bounded records.
    for (const entry of await journal.events(events)) if (sink) publish(entry);
  }
  function cancelIdle() { if (idle) clearTimeout(idle); idle = undefined; }
  function armIdle() {
    cancelIdle();
    idle = setTimeout(() => {
      if (journal.state !== 'ready' || !terminal) return;
      stopping = true;
      const current = terminal;
      void current.input({ type: 'eof' }).catch(() => current.cancel());
    }, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    idle.unref();
  }

  async function observe(frame: ClaudeFrame, observedTurn: number) {
    if (frame.type === 'control_response') {
      const response = object(frame.response);
      const subtype = controls.get(String(response.request_id));
      controls.delete(String(response.request_id));
      if (subtype === 'initialize' && response.subtype !== 'error') initialized = object(response.response);
    }
    if (frame.type === 'result' && observedTurn === turn) { await record({ type: 'state', state: 'ready' }); armIdle(); }
  }

  function flushObserved(): Promise<void> {
    if (flushTimer) clearTimeout(flushTimer); flushTimer = undefined;
    const frames = buffered; buffered = []; bufferedBytes = 0;
    const observedTurn = turn;
    if (!frames.length) return flushing;
    flushing = flushing.then(async () => {
      if (frames.some(frame => frame.type === 'user' || frame.type === 'result')) await journal.checkpoint();
      await bytes('stdout', Buffer.from(frames.map(frame => JSON.stringify(frame) + '\n').join('')));
      for (const frame of frames) await observe(frame, observedTurn);
    });
    return flushing;
  }

  async function stdout(raw: Buffer) {
    const frames = decoder.push(raw);
    if (!frames.length) return;
    buffered.push(...frames); bufferedBytes += raw.length;
    const deltaOnly = frames.every(frame => frame.type === 'stream_event' && object(frame.event).type === 'content_block_delta');
    const leading = firstDelta;
    firstDelta = !deltaOnly;
    if (!deltaOnly || leading || bufferedBytes >= 48 * 1024) await flushObserved();
    else flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      void flushObserved().catch(() => terminal?.cancel());
    }, TEXT_BATCH_MS);
  }

  return {
    async open(command: Start, intake: Context): Promise<TerminalReply> {
      await load();
      if (journal.configuration && (journal.configuration.directoryName !== command.directoryName || JSON.stringify(journal.configuration.git) !== JSON.stringify(command.git)))
        throw new Error('This session belongs to another project checkout. Use its original project and workspace.');
      if (command.tty || command.argv.some(selectsClaudeSession))
        throw new Error('Run juiced claude in the original terminal tab, or juiced claude --session ID to select a Juiced conversation. Native conversation flags are unavailable in the local TUI.');
      if (stopping) await running;
      if (!running) {
        if (!journal.configuration) await journal.configure(command);
        else if (command.localPublish && !journal.configuration.localPublish) await journal.configure({ ...journal.configuration, localPublish: command.localPublish });
        command = journal.configuration!;
        if (!journal.conversation) await journal.setConversation(randomUUID());
        const resume = await transcriptExists(workspace, journal.conversation);
        if (journal.resumable && !resume) throw new Error('The saved Claude transcript is unavailable. This conversation cannot be resumed.');
        if (command.git && command.directoryName) {
          // Activation is fenced to one runtime. No native process owns an old
          // registration here, including one acquired just before sandbox loss.
          const db = await context.database();
          await db.execute('CREATE TABLE IF NOT EXISTS juiced_checkout_leases (token TEXT PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL)');
          await db.execute({ sql: 'DELETE FROM juiced_checkout_leases WHERE project = ? AND session = ?', args: [command.directoryName, context.session.id] });
        }
        const interrupted = journal.state === 'working';
        epoch = randomUUID(); initialized = undefined; decoder = new ClaudeDecoder(); firstDelta = true; controls.clear(); stopping = false;
        await journal.event({ type: 'reset', epoch, interrupted });
        terminal = factory();
        let complete!: () => void;
        running = new Promise<void>(resolve => { complete = resolve; });
        // A queue also covers the short interval between native exit and activity settlement.
        intake.activity.queue(async activity => {
          sink = activity.output; view = activity.view; outputSignal = activity.signal;
          try {
            const argv = [...command.argv, '--replay-user-messages', resume ? '--resume' : '--session-id', journal.conversation];
            await terminal!.run({ ...command, argv }, { signal: activity.signal, output: { async send(event) {
              if (event.type === 'output') {
                const raw = Buffer.from(event.data, 'base64');
                if (event.channel === 'stdout') await stdout(raw);
                else await bytes('stderr', raw);
              } else if (event.type === 'ready') { await record({ type: 'state', state: 'ready' }); armIdle(); }
              else if (event.type === 'local-publish' || event.type === 'local-publish-done') await record(event);
              else if (event.type === 'error') await bytes('stderr', Buffer.from(event.message + '\n'));
            } } });
          } catch (error) {
            await bytes('stderr', Buffer.from((error instanceof Error ? error.message : 'Remote Claude stopped') + '\n'));
          } finally {
            stopping = true;
            try {
              await flushObserved();
              if (journal.state === 'working') await record({ type: 'reset', epoch: '', interrupted: true });
              await record({ type: 'state', state: 'sleeping' });
              await publication;
            } finally {
              cancelIdle();
              sink = undefined; terminal = undefined; running = undefined; stopping = false; complete();
            }
          }
        }, { timeoutMs: options.runTimeoutMs ?? RUN_TIMEOUT_MS, onCancel: () => { terminal?.cancel(); } });
      }
      if (journal.state === 'ready') armIdle();
      return { ok: true, agent: { epoch, ...(initialized ? { initialized } : {}) } };
    },
    async send(command: Extract<TerminalCommand, { type: 'agent-input' }>) {
      await load();
      if (!/^[0-9a-f-]{36}$/i.test(command.id) || typeof object(command.frame).type !== 'string') throw new Error('Invalid agent input');
      const text = JSON.stringify(command.frame) + '\n';
      if (Buffer.byteLength(text) > 768 * 1024) throw new Error('Agent input is too large');
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = journal.inputs.get(command.id);
      if (previous) {
        if (previous.hash !== hash) throw new Error('Agent input identity conflict');
        if (!previous.delivered) throw new Error('Previous input delivery was interrupted; inspect the conversation before continuing.');
        return;
      }
      if (command.epoch !== epoch || !running || stopping) throw new Error('The Claude process changed. Reconnect before submitting input.');
      cancelIdle();
      if (command.frame.type === 'user') turn++;
      await journal.input(command.id, hash, epoch, false);
      if (command.frame.type === 'control_request') controls.set(String(command.frame.request_id), String(object(command.frame.request).subtype));
      if (command.frame.type === 'control_response') await record({ type: 'approval-answer', id: String(object(command.frame.response).request_id) });
      if (command.frame.type === 'user') {
        const text = Buffer.from(String(object(command.frame.message).content));
        for (let offset = 0; offset < text.length; offset += 12 * 1024)
          await record({ type: 'user', id: command.id, data: text.subarray(offset, offset + 12 * 1024).toString('base64'), final: offset + 12 * 1024 >= text.length });
        await record({ type: 'state', state: 'working' });
      }
      const raw = Buffer.from(text);
      for (let offset = 0; offset < raw.length; offset += MAX_INPUT_BYTES)
        await terminal!.input({ type: 'input', data: raw.subarray(offset, offset + MAX_INPUT_BYTES).toString('base64') });
      await journal.input(command.id, hash, epoch, true);
      if (journal.state === 'ready') armIdle();
    },
    async replay(after: number): Promise<TerminalReply> { await load(); return { ok: true, replay: await journal.page(after) }; },
    async streamReplay(after: number, id: string, intake: Context): Promise<void> {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid agent replay identity');
      const pending: Promise<void>[] = [];
      const flush = async () => {
        await Promise.all(pending.splice(0));
        // Keep a recent subscription boundary even when history exceeds transport retention.
        await intake.view.commit({ agentSequence: journal.latest });
      };
      try {
        await load();
        let page = await journal.page(after);
        const latest = page.latest;
        while (page.entries.length) {
          intake.signal.throwIfAborted();
          const sent = intake.output.send({ type: 'agent-replay', id, entries: page.entries });
          void sent.catch(() => {});
          pending.push(sent);
          // Pipeline bounded batches so each page does not wait for its own durable handoff.
          if (pending.length === 12) await flush();
          after = page.entries.at(-1)!.sequence;
          if (after >= latest) break;
          page = await journal.page(after, latest);
        }
        await flush();
        await intake.output.send({ type: 'agent-replay-end', id, latest });
        await intake.view.commit({ agentSequence: journal.latest });
      } catch (error) {
        await Promise.allSettled(pending);
        if (intake.signal.aborted) throw error;
        await intake.output.send({ type: 'agent-replay-end', id, latest: journal.latest, error: error instanceof Error ? error.message : 'Agent history replay failed' });
      }
    },
    get active() { return Boolean(running); },
    async input(command: TerminalCommand) {
      if (!terminal) throw new Error('Claude is sleeping');
      const reply = await terminal.input(command);
      if (reply.ok && command.type === 'save-settings' && journal.configuration) {
        if (initialized) {
          if (command.settings.permissionMode !== undefined) initialized.current_permission_mode = command.settings.permissionMode;
          if (command.settings.outputStyle !== undefined) initialized.output_style = command.settings.outputStyle;
          if (command.settings.fastMode !== undefined) initialized.fast_mode_state = command.settings.fastMode ? 'on' : 'off';
        }
        const configuration = journal.configuration;
        let argv = [...configuration.argv];
        for (const [key, flag] of [['model', '--model'], ['effortLevel', '--effort']] as const) {
          const value = command.settings[key];
          if (value === undefined) continue;
          argv = argv.filter((arg, index, values) => arg !== flag && values[index - 1] !== flag && !arg.startsWith(flag + '='));
          argv.push(flag, value);
        }
        await journal.configure({ ...configuration, argv });
      }
      return reply;
    },
    async dispose() { cancelIdle(); terminal?.cancel(); await running; await journal.close(); },
  };
}
