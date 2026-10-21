import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionContext, SessionHarnessContext } from '@cantelop/sdk/session';
import type { SessionEvent, SessionEventCursor } from '@cantelop/sdk';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import { ClaudeDecoder, object, type ClaudeFrame } from '../src/agent-protocol.js';
import { createDurableAgent } from '../src/runtime/durable-agent.js';
import { AgentJournal } from '../src/runtime/agent-journal.js';
import type { createTerminal } from '../src/runtime/terminal.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from '../src/protocol.js';
import { prepareAgentSession } from '../src/session-state.js';
import { commandMenu } from '../src/tui/command-menus.js';
import type { Publication, UploadRequest } from '../src/publish-protocol.js';
import { until } from './fixtures/wait.js';

async function fixture(t: test.TestContext, idleTimeoutMs = 60_000, sessionId = 'test', agentOptions: ConstructorParameters<typeof RemoteAgent>[1] = {}) {
  const root = await mkdtemp('/tmp/juiced-durable-');
  const lifetime = new AbortController(), events = new EventEmitter();
  const stored: SessionEvent<TerminalEvent>[] = [];
  const prompts: string[] = [], promptModes: string[] = [], launches: string[][] = [], requests: TerminalCommand[] = [], replays: Extract<TerminalCommand, { type: 'agent-replay' }>[] = [];
  const replayWork: Promise<void>[] = [];
  const requestIds: Array<{ command: TerminalCommand; id: string | undefined }> = [];
  let currentOutput: { send(event: TerminalEvent): Promise<void> };
  let clientOffline = false, streamPaused = false, loseReply = false, expired = false, stops = 0, initializations = 0;
  let viewCursor: SessionEventCursor | undefined;
  let viewState: unknown;
  let activityTimeout = 0;
  let rejectedPermissionMode: string | undefined;
  let replayHook: ((event: Extract<TerminalEvent, { type: 'agent-replay' }>) => Promise<void>) | undefined;
  let outputHook: ((event: Extract<TerminalEvent, { type: 'agent-output' }>) => Promise<void>) | undefined;
  let viewHook: (() => Promise<void>) | undefined;
  const views: number[] = [];
  const publications = new Map<string, string | undefined>();
  const output = { async send(data: TerminalEvent) {
    stored.push({ data, sessionId, messageId: `msg_${'1'.repeat(32)}`, createdAt: new Date(), cursor: { streamId: 'a'.repeat(32), sequence: stored.length + 1 } });
    events.emit('event');
    if (data.type === 'agent-replay') await replayHook?.(data);
    if (data.type === 'agent-output') await outputHook?.(data);
  } };
  const raw = async (value: Buffer) => currentOutput.send({ type: 'output', channel: 'stdout', data: value.toString('base64') });
  const frame = async (value: ClaudeFrame) => raw(Buffer.from(JSON.stringify(value) + '\n'));
  const context = { signal: lifetime.signal, session: { id: sessionId, keepAliveSeconds: 120 }, env: {}, database: async () => { throw new Error('unused'); } } as SessionHarnessContext;
  const factory = () => {
    let decoder = new ClaudeDecoder(), finish!: () => void;
    let permissionMode = 'default';
    const done = new Promise<void>(resolve => { finish = resolve; });
    return {
      async run(command: Extract<TerminalCommand, { type: 'start' }>, work: { output: typeof output; signal: AbortSignal }) {
        launches.push(command.argv); currentOutput = work.output;
        const modeIndex = command.argv.indexOf('--permission-mode');
        permissionMode = command.argv.includes('--dangerously-skip-permissions') ? 'bypassPermissions'
          : modeIndex >= 0 ? command.argv[modeIndex + 1]!
          : command.argv.find(arg => arg.startsWith('--permission-mode='))?.split('=')[1] ?? 'default';
        await work.output.send({ type: 'ready' });
        const abort = () => finish();
        work.signal.addEventListener('abort', abort, { once: true });
        try { await done; } finally { work.signal.removeEventListener('abort', abort); }
        return { ok: true };
      },
      async input(command: TerminalCommand) {
        if (command.type === 'publish-status' || command.type === 'publish-claim' || command.type === 'publish-result') {
          if (!publications.has(command.id)) throw new Error('This publication is no longer pending.');
          if (command.type === 'publish-claim') publications.set(command.id, command.client);
          if (command.type === 'publish-result') { publications.delete(command.id); await currentOutput.send({ type: 'local-publish-done', id: command.id }); }
          return { ok: true };
        }
        if (command.type === 'eof') { finish(); return { ok: true }; }
        if (command.type !== 'input') return { ok: true };
        for (const value of decoder.push(Buffer.from(command.data, 'base64'))) {
          if (value.type === 'control_request') {
            const subtype = object(value.request).subtype;
            if (subtype === 'initialize') initializations++;
            if (subtype === 'set_permission_mode') {
              const mode = String(object(value.request).mode);
              if (mode === rejectedPermissionMode) {
                await frame({ type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: 'Permission mode unavailable' } });
                continue;
              }
              permissionMode = mode;
            }
            await frame({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id,
              response: subtype === 'initialize' ? { current_permission_mode: permissionMode, commands: [{ name: 'compact' }], models: [{ value: 'sonnet' }] } : {} } });
          } else if (value.type === 'user') {
            prompts.push(String(object(value.message).content));
            promptModes.push(permissionMode);
            const argv = launches.at(-1)!;
            const id = argv.at(-1)!;
            await mkdir(join(root, '.claude', 'projects', 'test'), { recursive: true });
            await writeFile(join(root, '.claude', 'projects', 'test', `${id}.jsonl`), 'native checkpoint');
            await frame({ type: 'user', uuid: value.uuid, message: { role: 'user', content: object(value.message).content } });
          }
        }
        return { ok: true };
      },
      cancel() { finish(); return true; },
    } as unknown as ReturnType<typeof createTerminal>;
  };
  const service = createDurableAgent(context, factory, root, { idleTimeoutMs, handoffRetryMs: 5, handoffRetryMaxMs: 20 });
  let activity = Promise.resolve();
  const view = { async commit(state: unknown) { views.push(Number(object(state).agentSequence)); viewState = state; viewCursor = stored.at(-1)?.cursor; await viewHook?.(); } };
  const intake = { ...context, output, view, activity: { queue(work: (context: unknown) => Promise<void>, options: { timeoutMs: number }) {
    activityTimeout = options.timeoutMs;
    activity = activity.then(() => work({ output, signal: lifetime.signal, view }));
    void activity.catch(() => {});
  } } } as unknown as SessionContext<TerminalCommand, TerminalEvent, TerminalReply>;
  const network = () => { if (clientOffline) throw new Error('network unavailable'); };
  const session: AgentSession = {
    id: sessionId,
    async request(command, options) {
      network(); requests.push(command); requestIds.push({ command, id: options?.id });
      if (command.type === 'start') return service.open(command, intake);
      if (command.type === 'agent-replay') return service.replay(command.after);
      if (command.type === 'save-settings') return service.input(command);
      if (command.type === 'publish-status' || command.type === 'publish-claim' || command.type === 'publish-result') {
        try { return await service.input(command); } catch (error) { return { ok: false, error: (error as Error).message }; }
      }
      if (command.type === 'agent-input') {
        try { await service.send(command); }
        catch (error) { return { ok: false, error: (error as Error).message }; }
        if (loseReply && command.frame.type === 'user') { loseReply = false; throw new Error('network response lost'); }
      }
      return { ok: true };
    },
    async dispatch(command) {
      network();
      if (command.type !== 'agent-replay' || !command.stream) throw new Error('Durable input must await an idempotent application receipt');
      replays.push(command);
      const work = service.streamReplay(command.after, command.stream, intake);
      void work.catch(() => {}); replayWork.push(work);
      return { id: `msg_${'2'.repeat(32)}`, state: 'accepted', acceptedAt: new Date(), async status() { return { id: `msg_${'2'.repeat(32)}`, state: 'handled', acceptedAt: new Date(), startedAt: new Date(), handledAt: new Date() }; } };
    },
    async view() {
      network();
      if (!viewCursor) throw Object.assign(new Error('missing view'), { code: 'session_view_not_found', status: 404 });
      return { revision: 'view', updatedAt: new Date(), state: viewState, cursor: viewCursor };
    },
    async *stream(options) {
      network();
      if (expired) { expired = false; throw Object.assign(new Error('expired'), { code: 'event_cursor_expired', status: 409 }); }
      let index = options?.after?.sequence ?? 0;
      while (!options?.signal?.aborted) {
        network();
        if (!stored[index] || streamPaused) await once(events, 'event', { signal: options?.signal });
        network();
        if (expired) { expired = false; throw Object.assign(new Error('expired'), { code: 'event_cursor_expired', status: 409 }); }
        if (stored[index] && !streamPaused) yield stored[index++]!;
      }
    },
    async stop() { stops++; lifetime.abort(); await activity; },
  };
  const agent = new RemoteAgent(session, { controlTimeoutMs: 10_000, ...agentOptions });
  const received: ClaudeFrame[] = [];
  agent.on('frame', value => received.push(value));
  t.after(async () => { await agent.close(false); lifetime.abort(); await activity; await Promise.allSettled(replayWork); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, agent, session, service, frame, raw, prompts, promptModes, launches, requests, requestIds, replays, stored, received, views,
    async upload(request: UploadRequest) { publications.set(request.id, undefined); await currentOutput.send({ type: 'local-upload', request }); },
    async publish(publication: Publication, active = true) { if (active) publications.set(publication.id, undefined); await currentOutput.send({ type: 'local-publish', publication }); },
    onReplay(hook: typeof replayHook) { replayHook = hook; },
    onOutput(hook: typeof outputHook) { outputHook = hook; },
    onView(hook: typeof viewHook) { viewHook = hook; },
    get stops() { return stops; }, get initializations() { return initializations; }, get activityTimeout() { return activityTimeout; },
    offline(value: boolean) { clientOffline = value; events.emit('event'); },
    pauseStream(value: boolean) { streamPaused = value; events.emit('event'); },
    loseReply() { loseReply = true; },
    expireStream() { expired = true; events.emit('event'); },
    rejectPermissionMode(mode?: string) { rejectedPermissionMode = mode; },
  };
}

test('the first text delta is durable immediately and following deltas flush within a short batch', async t => {
  const f = await fixture(t); await f.agent.start();
  const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  const started = performance.now();
  await f.frame(delta('leading-delta'));
  const replay = await f.service.replay(0);
  assert.ok(replay.ok && replay.replay);
  assert.ok(JSON.stringify(replay.replay).includes(Buffer.from(JSON.stringify(delta('leading-delta')) + '\n').toString('base64')), 'The first delta must be committed before stdout returns');
  const leadingMs = performance.now() - started;
  const next = performance.now();
  await f.frame(delta('batched-delta'));
  await until(() => JSON.stringify(f.received).includes('batched-delta'), 200);
  t.diagnostic(`Local journal/publication: leading ${leadingMs.toFixed(1)} ms, batched ${(performance.now() - next).toFixed(1)} ms`);
});

function publication(): Publication {
  return { id: randomUUID(), kind: 'commits', summary: 'Bring completed changes back', expiresAt: Date.now() + 60_000, paths: ['README.md'], fileCount: 1,
    manifest: { head: 'a'.repeat(40), sourceBranch: 'main', file: { name: 'bundle', size: 0, sha256: 'b'.repeat(64) } } };
}

test('local publication requires its own explicit approval and denial never calls the local writer', async t => {
  let writes = 0;
  const options = { localPublish: { head: 'a'.repeat(40), async apply() { writes++; return { status: 'applied' as const, message: 'Applied locally' }; } } };
  const f = await fixture(t, 60_000, 'publication-approval', options);
  await f.agent.start();
  const denied = publication(); await f.publish(denied);
  await until(() => f.agent.approvals.has(denied.id));
  assert.equal(f.agent.approvals.get(denied.id)?.local, true);
  assert.equal(writes, 0);
  await f.agent.answer(denied.id, false);
  assert.equal(writes, 0);
  assert.ok(f.requests.some(command => command.type === 'publish-result' && command.id === denied.id && command.result.status === 'declined'));
  const allowed = publication(); await f.publish(allowed);
  await until(() => f.agent.approvals.has(allowed.id));
  await f.agent.answer(allowed.id, true);
  assert.equal(writes, 1);
  assert.ok(f.received.some(frame => frame.type === 'juiced_publish' && frame.message === 'Applied locally'));
  await assert.rejects(f.agent.answer(allowed.id, true), /no longer active/);
  f.expireStream();
  await until(() => f.replays.length > 1);
  await delay(50); // Negative check: give the replayed offer time to (wrongly) reach the writer.
  assert.equal(writes, 1, 'Replaying a completed publication must never apply it again');
  assert.equal(f.agent.approvals.size, 0);
});

test('reattachment recaptures pending uploads and a completed upload is never replayed', async t => {
  let captures = 0, sends = 0, discarded = 0;
  const options = { localPublish: { head: 'a'.repeat(40), async apply() { throw new Error('Not a publication'); }, upload: {
    async prepare() { captures++; return { files: 1, paths: ['README.md'] }; },
    async send() { sends++; return { status: 'applied' as const, message: 'Uploaded', uploadId: randomUUID() }; },
    async discard() { discarded++; },
  } } };
  const f = await fixture(t, 60_000, 'upload-resume', options); await f.agent.start();
  const request: UploadRequest = { id: randomUUID(), kind: 'upload', summary: 'Pull laptop edits', expiresAt: Date.now() + 60_000,
    head: 'a'.repeat(40), sourceBranch: 'main', includeUncommitted: true };
  await f.upload(request); await until(() => f.agent.approvals.has(request.id));
  assert.equal(captures, 1); assert.equal(sends, 0);
  await f.agent.close(false);
  assert.ok(discarded > 0, 'A detached client removes its unapproved snapshot');
  const resumed = new RemoteAgent(f.session, options);
  t.after(() => resumed.close(false));
  await resumed.start(); await until(() => resumed.approvals.has(request.id));
  assert.equal(captures, 2, 'Reattachment captures a new preview requiring fresh approval');
  await resumed.answer(request.id, true);
  assert.equal(sends, 1);
  f.expireStream(); await until(() => f.replays.length > 1);
  assert.equal(sends, 1);
});

test('reattachment restores a live publication offer and ignores historical or expired offers', async t => {
  let writes = 0;
  const options = { localPublish: { head: 'a'.repeat(40), async apply() { writes++; return { status: 'applied' as const, message: 'Applied' }; } } };
  const f = await fixture(t, 60_000, 'publication-resume', options); await f.agent.start();
  const pending = publication(); await f.publish(pending);
  await until(() => f.agent.approvals.has(pending.id));
  await f.agent.close(false);
  const reattached = new RemoteAgent(f.session, options);
  try {
    await reattached.start();
    await until(() => reattached.approvals.has(pending.id));
    assert.equal(writes, 0);
    await reattached.answer(pending.id, false);
    const old = publication(); await f.publish(old, false);
    const expired = { ...publication(), expiresAt: Date.now() - 1000 }; await f.publish(expired);
    await delay(50); // Negative check: stale offers must never surface.
    assert.equal(reattached.approvals.size, 0);
    assert.equal(writes, 0);
  } finally { await reattached.close(false); }
});

test('slow output acknowledgments use a bounded pipeline without skipping journal entries or replaying', async t => {
  let release = () => {};
  t.after(() => release());
  const f = await fixture(t); await f.agent.start();
  const history = await f.service.replay(0); assert.ok(history.ok && history.replay);
  const boundary = history.replay.latest;
  await until(() => f.stored.some(event => event.data.type === 'agent-output' && event.data.sequence === boundary));
  const replayCount = f.replays.length;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.onOutput(async event => { if (event.sequence > boundary) await blocked; });
  for (let index = 0; index < 40; index++) await f.frame({ type: 'assistant', message: { id: `pipelined-${index}`, content: [{ type: 'text', text: `${index}` }] } });
  const published = () => f.stored.filter(event => event.data.type === 'agent-output' && event.data.sequence > boundary);
  await until(() => published().length >= 12);
  await delay(20); // Negative check: no 13th output may be sent while acknowledgments are blocked.
  assert.equal(published().length, 12, 'Outstanding output must stay bounded while acknowledgments are blocked');
  assert.equal(f.views.at(-1), boundary + 12, 'The view must join the same handoff and stop at its last enqueued event');
  release();
  await until(() => f.received.filter(frame => frame.type === 'assistant' && String(object(frame.message).id).startsWith('pipelined-')).length === 40);
  assert.deepEqual(published().map(event => event.data.type === 'agent-output' ? event.data.sequence : 0), Array.from({ length: 40 }, (_, index) => boundary + index + 1));
  assert.equal(f.replays.length, replayCount);
});

test('batched journal appends keep consecutive sequences across concurrent writes and replacement', async t => {
  const root = await mkdtemp('/tmp/juiced-journal-batch-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new AgentJournal(root, 'batch'); await journal.open();
  const batch = journal.events(Array.from({ length: 8 }, (_, index) => ({ type: 'bytes' as const, channel: 'stdout' as const, data: Buffer.from(`${index}`).toString('base64') })));
  const single = journal.event({ type: 'state', state: 'ready' });
  assert.deepEqual((await batch).map(entry => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await single).sequence, 9);
  await journal.close();
  const restored = new AgentJournal(root, 'batch'); await restored.open();
  try {
    assert.equal(restored.latest, 9);
    assert.equal(restored.state, 'ready');
    assert.deepEqual((await restored.page(0)).entries.map(entry => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  } finally { await restored.close(); }
});

test('a stalled view acknowledgment does not block live output or accumulate view writes', async t => {
  let release = () => {};
  t.after(() => release());
  const f = await fixture(t); await f.agent.start();
  const history = await f.service.replay(0); assert.ok(history.ok && history.replay);
  const latest = history.replay.latest;
  await until(() => f.views.at(-1) === latest);
  const before = f.views.length;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.onView(() => blocked);
  for (let index = 0; index < 30; index++) await f.frame({ type: 'assistant', message: { id: `view-stalled-${index}`, content: [{ type: 'text', text: `${index}` }] } });
  await until(() => f.received.filter(frame => frame.type === 'assistant' && String(object(frame.message).id).startsWith('view-stalled-')).length === 30);
  assert.equal(f.views.length - before, 1, 'Only one view handoff may remain outstanding');
  release();
});

test('a failed handoff retries from its acknowledged prefix without duplicating displayed frames', async t => {
  const f = await fixture(t); await f.agent.start();
  let failed = false;
  f.onOutput(async event => {
    if (!failed && event.event.type === 'bytes' && Buffer.from(event.event.data, 'base64').toString().includes('retry-handoff')) { failed = true; throw new Error('Lost collector acknowledgment'); }
  });
  await f.frame({ type: 'assistant', message: { id: 'retry-handoff', content: [{ type: 'text', text: 'Once' }] } });
  await until(() => failed);
  const first = f.stored.find(event => event.data.type === 'agent-output' && event.data.event.type === 'bytes' && Buffer.from(event.data.event.data, 'base64').toString().includes('retry-handoff'));
  assert.ok(first && first.data.type === 'agent-output');
  const sequence = first.data.sequence;
  await until(() => f.stored.filter(event => event.data.type === 'agent-output' && event.data.sequence === sequence).length === 2);
  assert.equal(f.received.filter(frame => frame.type === 'assistant' && object(frame.message).id === 'retry-handoff').length, 1);
  const diagnostics = () => f.stored.filter(event => event.data.type === 'agent-output' && event.data.event.type === 'bytes' && event.data.event.channel === 'stderr' &&
    Buffer.from(event.data.event.data, 'base64').toString().includes('Lost collector acknowledgment'));
  await until(() => diagnostics().length > 0);
  assert.equal(diagnostics().length, 1, 'The handoff error must be journaled once per failure streak');
});

test('a disconnected client recovers large history with one streamed replay and deduplicates output', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.agent.start(); await f.agent.submit('Keep working while the laptop sleeps');
  assert.equal(f.activityTimeout, 24 * 60 * 60 * 1000);
  f.offline(true);
  for (let index = 0; index < 330; index++) await f.frame({ type: 'assistant', message: { id: `answer-${index}`, content: [{ type: 'text', text: `${index} ` + '🍈'.repeat(1000) }] } });
  await f.frame({ type: 'result', result: 'Complete' });
  assert.equal(f.stops, 0); assert.equal(f.prompts.length, 1);
  const before = f.replays.length;
  f.offline(false);
  await until(() => f.received.some(value => value.type === 'result'));
  assert.equal(f.received.filter(value => value.type === 'assistant').length, 330);
  assert.equal(f.received.filter(value => value.type === 'result').length, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.requests.some(value => value.type === 'heartbeat'), false);
  assert.equal(f.requests.filter(value => value.type === 'agent-replay').length, 0);
  assert.equal(f.replays.length - before, 1, 'History larger than the reply/transport window needs only one command');
});

test('an interrupted streamed reattachment resumes after its last journal entry without repeating frames', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.agent.start(); await f.agent.submit('Restore a large conversation'); await f.agent.close(false);
  for (let index = 0; index < 200; index++) await f.frame({ type: 'assistant', message: { id: `saved-${index}`, content: [{ type: 'text', text: `${index} ` + '🍈'.repeat(2000) }] } });
  await f.frame({ type: 'result', result: 'Recovered' });
  let dropped = false, boundary = 0;
  const session: AgentSession = { ...f.session, async *stream(options) {
    for await (const event of f.session.stream(options)) {
      yield event;
      if (!dropped && event.data.type === 'agent-replay') {
        dropped = true; boundary = event.data.entries.at(-1)!.sequence;
        throw new Error('network stream lost during replay');
      }
    }
  } };
  const next = new RemoteAgent(session); t.after(() => next.close(false));
  const frames: ClaudeFrame[] = []; next.on('frame', frame => frames.push(frame));
  const before = f.replays.length;
  await next.start();
  assert.equal(dropped, true);
  assert.ok(boundary > 0);
  assert.equal(f.replays[before + 1]?.after, boundary);
  assert.equal(frames.filter(frame => frame.type === 'assistant').length, 200);
  assert.equal(frames.filter(frame => frame.type === 'result').length, 1);
  assert.equal(new Set(frames.filter(frame => frame.type === 'assistant').map(frame => object(frame.message).id)).size, 200);
  assert.deepEqual(f.prompts, ['Restore a large conversation']);
});

test('live output interleaved with a fixed replay snapshot catches up through coalesced notifications', async t => {
  const f = await fixture(t);
  await f.agent.start(); await f.agent.submit('Continue during reconnect'); await f.agent.close(false);
  for (let index = 0; index < 20; index++) await f.frame({ type: 'assistant', message: { id: `saved-${index}`, content: [{ type: 'text', text: 'saved '.repeat(2000) }] } });
  let injected = false;
  f.onReplay(async () => {
    if (injected) return;
    injected = true;
    for (let index = 0; index < 10; index++) await f.frame({ type: 'assistant', message: { id: `live-${index}`, content: [{ type: 'text', text: `Live output ${index}` }] } });
    await f.frame({ type: 'result', result: 'Finished during replay' });
  });
  const next = new RemoteAgent(f.session); t.after(() => next.close(false));
  const frames: ClaudeFrame[] = []; next.on('frame', frame => frames.push(frame));
  await next.start();
  await until(() => frames.some(frame => frame.type === 'result'));
  assert.equal(frames.filter(frame => frame.type === 'assistant').length, 30);
  assert.equal(new Set(frames.filter(frame => frame.type === 'assistant').map(frame => object(frame.message).id)).size, 30);
  assert.equal(frames.filter(frame => frame.type === 'result').length, 1);
  assert.deepEqual(f.prompts, ['Continue during reconnect']);
});

test('an ambiguous input acknowledgment retries the same identity without delivering twice', async t => {
  const f = await fixture(t); await f.agent.start();
  f.loseReply(); await f.agent.submit('Only once');
  assert.deepEqual(f.prompts, ['Only once']);
  const sent = f.requestIds.filter(value => value.command.type === 'agent-input' && value.command.frame.type === 'user');
  assert.equal(sent.length, 2); assert.equal(sent[0]?.id, sent[1]?.id);
});

test('connection retries continue beyond three attempts and remain cancellable', { timeout: 10_000 }, async t => {
  const f = await fixture(t); let reconnects = 0;
  f.agent.on('reconnecting', () => reconnects++); f.offline(true);
  const started = f.agent.start();
  await until(() => reconnects >= 4); assert.equal(f.stops, 0);
  f.offline(false); await started; assert.equal(f.agent.status, 'ready');
  // Closing during a backoff wait must abort the retry loop promptly instead of waiting out the delay.
  f.offline(true);
  const cancelled = new RemoteAgent(f.session); let retries = 0;
  cancelled.on('reconnecting', () => retries++);
  const pending = cancelled.start(); void pending.catch(() => {});
  await until(() => retries >= 2);
  const closing = performance.now();
  await cancelled.close(false);
  await assert.rejects(pending);
  assert.ok(performance.now() - closing < 400, 'Closing must interrupt the pending backoff delay');
  assert.equal(retries, 2); assert.equal(f.stops, 0);
});

test('input receipts reject conflicting payloads and stale native process epochs', async t => {
  const f = await fixture(t); await f.agent.start(); await f.agent.submit('Original');
  const receipt = f.requestIds.find(value => value.command.type === 'agent-input' && value.command.frame.type === 'user')!.command;
  assert.equal(receipt.type, 'agent-input');
  if (receipt.type !== 'agent-input') return;
  await assert.rejects(f.service.send({ ...receipt, frame: { type: 'user', message: { content: 'Different' } } }), /identity conflict/);
  await assert.rejects(f.service.send({ ...receipt, id: randomUUID(), epoch: randomUUID() }), /process changed/);
  assert.deepEqual(f.prompts, ['Original']);
});

test('permission answers cannot splice native output split inside a UTF-8 JSON frame', async t => {
  const f = await fixture(t); await f.agent.start(); await f.agent.submit('Permission');
  await f.frame({ type: 'control_request', request_id: 'approve', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
  await until(() => f.agent.approvals.has('approve'));
  const output = Buffer.from(JSON.stringify({ type: 'assistant', message: { id: 'split', content: [{ type: 'text', text: 'A split 🍈 response' }] } }) + '\n');
  const split = output.indexOf(Buffer.from('🍈')) + 1;
  await f.raw(output.subarray(0, split)); await f.agent.answer('approve', false);
  await f.raw(output.subarray(split)); await f.frame({ type: 'result', result: 'Complete' });
  await until(() => f.received.some(value => value.type === 'result'));
  const assistant = f.received.filter(value => value.type === 'assistant');
  assert.equal(assistant.length, 1); assert.match(JSON.stringify(assistant), /A split 🍈 response/);
});

test('an expired transport cursor recovers journal history without duplicating a completed turn', async t => {
  const f = await fixture(t); await f.agent.start(); await f.agent.submit('First');
  await f.frame({ type: 'result', result: 'One completed turn' });
  await until(() => f.received.some(value => value.type === 'result'));
  const before = f.replays.length;
  f.expireStream();
  await until(() => f.replays.length > before);
  await f.agent.submit('Second'); await f.frame({ type: 'result', result: 'Two' });
  await until(() => f.received.filter(value => value.type === 'result').length === 2);
  assert.deepEqual(f.prompts, ['First', 'Second']);
});

test('reattachment restores the whole conversation and pending permissions without starting another process', async t => {
  const f = await fixture(t); await f.agent.start(); await f.agent.submit('Wait for approval');
  await f.frame({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'test' } } });
  await until(() => f.agent.approvals.size === 1); await f.agent.close(false);
  const next = new RemoteAgent(f.session); t.after(() => next.close(false));
  const frames: ClaudeFrame[] = []; next.on('frame', frame => frames.push(frame));
  await next.start();
  assert.equal(next.status, 'working'); assert.equal(next.approvals.size, 1);
  assert.equal(f.launches.length, 1); assert.equal(f.initializations, 1);
  assert.ok(frames.some(value => value.type === 'juiced_user' && value.text === 'Wait for approval'));
  await next.answer('permission', false);
  await until(() => next.approvals.size === 0);
});

test('rerunning in the same terminal selects the durable session and restores its output without replaying input', async t => {
  const local = await mkdtemp('/tmp/juiced-terminal-reattach-'); t.after(() => rm(local, { recursive: true, force: true }));
  const project = { localDirectory: local, workspace: 'project' };
  const terminal = { identity: 'terminal-tab', workspaceId: 'workspace-id' };
  const first = await prepareAgentSession(project, { terminal }); await first.save();
  const f = await fixture(t, 60_000, first.id);
  await f.agent.start(); await f.agent.submit('Remember this terminal conversation');
  await f.frame({ type: 'result', result: 'Saved response' });
  await until(() => f.agent.status === 'ready'); await f.agent.close(false);
  const selected = await prepareAgentSession(project, { terminal }); await selected.save();
  assert.equal(selected.resumed, true); assert.equal(selected.id, f.session.id);
  const next = new RemoteAgent({ ...f.session, id: selected.id }); t.after(() => next.close(false));
  const frames: ClaudeFrame[] = []; next.on('frame', frame => frames.push(frame));
  await next.start();
  assert.ok(frames.some(frame => frame.type === 'result' && frame.result === 'Saved response'));
  assert.ok(frames.some(frame => frame.type === 'juiced_user' && frame.text === 'Remember this terminal conversation'));
  assert.deepEqual(f.prompts, ['Remember this terminal conversation']);
  assert.equal(f.launches.length, 1); assert.equal(f.stops, 0);
});

test('idle processes exit and the next prompt resumes the native conversation', async t => {
  // Leave enough time for initialization and input under native CI contention;
  // still wait for the observed idle exit before submitting the second turn.
  const f = await fixture(t, 500); await f.agent.start(); await f.agent.submit('First');
  await f.frame({ type: 'result', result: 'Saved first turn' });
  await until(() => !f.service.active);
  await f.agent.submit('Second');
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[0]?.at(-1), f.launches[1]?.at(-1));
  assert.ok(f.launches[1]?.includes('--resume'));
  assert.deepEqual(f.prompts, ['First', 'Second']);
});

test('session-only permission choices apply before prompts after idle native restarts', async t => {
  for (const argv of [['--permission-mode', 'acceptEdits'], ['--dangerously-skip-permissions']]) {
    await t.test(argv.join(' '), async t => {
      const f = await fixture(t, 150); await f.agent.start(argv);
      await f.agent.configure({ subtype: 'set_permission_mode', mode: 'plan' }, { persist: false });
      await f.agent.submit('First');
      await f.frame({ type: 'result', result: 'Saved' });
      await until(() => !f.service.active);
      await f.agent.submit('Second');
      assert.equal(f.launches.length, 2);
      assert.deepEqual(f.promptModes, ['plan', 'plan']);
      assert.equal(f.agent.info.current_permission_mode, 'plan');
      assert.equal(f.requests.some(command => command.type === 'save-settings'), false);

      await f.frame({ type: 'system', subtype: 'status', permissionMode: 'default' });
      await until(() => f.agent.info.current_permission_mode === 'default');
      await f.frame({ type: 'result', result: 'Left plan mode' });
      await until(() => !f.service.active);
      await f.agent.submit('After leaving plan mode');
      assert.equal(f.launches.length, 3);
      assert.equal(f.promptModes.at(-1), 'default', 'Claude mode changes must replace the session override');
    });
  }
});

test('a rejected permission restoration blocks the prompt and retries before later input', async t => {
  const f = await fixture(t, 150); await f.agent.start(['--permission-mode=acceptEdits']);
  await f.agent.configure({ subtype: 'set_permission_mode', mode: 'plan' }, { persist: false });
  await f.agent.submit('First');
  await f.frame({ type: 'result', result: 'Saved' });
  await until(() => !f.service.active);
  f.rejectPermissionMode('plan');
  await assert.rejects(f.agent.submit('Wait for plan mode'), /Permission mode unavailable/);
  assert.deepEqual(f.prompts, ['First'], 'A failed restoration must never deliver the queued prompt');
  assert.equal(f.agent.status, 'ready');
  f.rejectPermissionMode();
  await f.agent.submit('Retry in plan mode');
  assert.deepEqual(f.prompts, ['First', 'Retry in plan mode']);
  assert.deepEqual(f.promptModes, ['plan', 'plan']);
});

test('warm settings menus stay local and live data reads omit the process preflight', async t => {
  const f = await fixture(t); await f.agent.start();
  const before = f.requests.length;
  const config = await commandMenu(f.agent, 'config');
  await config.items.find(item => item.id === 'effort')!.run!();
  await config.items.find(item => item.id === 'permissions')!.run!();
  assert.equal(f.requests.length, before, 'Startup already fetched the settings used by these menus');
  await f.agent.query({ subtype: 'mcp_status' });
  assert.deepEqual(f.requests.slice(before).map(command => command.type), ['agent-input']);
  assert.deepEqual(f.prompts, []);
});

test('a menu read resumes a sleeping process even when its sleep notification has not arrived', async t => {
  const f = await fixture(t, 150); await f.agent.start(); await f.agent.submit('Remember this conversation');
  await f.frame({ type: 'result', result: 'Saved' });
  await until(() => f.agent.status === 'ready');
  f.pauseStream(true);
  await until(() => !f.service.active);
  let failure: unknown;
  f.agent.on('failure', error => { failure = error; });
  const before = f.requests.length;
  const reading = f.agent.query({ subtype: 'mcp_status' });
  await until(() => f.requests.slice(before).some(command => command.type === 'start'));
  f.pauseStream(false);
  await reading;
  assert.equal(failure, undefined);
  assert.equal(f.agent.status, 'ready');
  assert.equal(f.launches.length, 2);
  assert.ok(f.launches[1]?.includes('--resume'));
  const reads = f.requests.slice(before).filter(command => command.type === 'agent-input' && object(command.frame.request).subtype === 'mcp_status');
  assert.equal(reads.length, 2, 'Retry only after the runtime explicitly rejected the stale epoch before delivery');
  assert.deepEqual(f.prompts, ['Remember this conversation']);
});

test('confirmed menu model choices override launch flags after idle native resumption', async t => {
  const f = await fixture(t, 50); await f.agent.start(['--model', 'opus']);
  await f.agent.setModel('sonnet'); await f.agent.submit('First');
  await f.frame({ type: 'result', result: 'Saved' }); await until(() => !f.service.active);
  await f.agent.submit('Second');
  const argv = f.launches.at(-1)!;
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.ok(argv.includes('--resume'));
});

test('journal replacement retains all bytes, repairs a partial final append, and preserves uncertain input receipts', async t => {
  const root = await mkdtemp('/tmp/juiced-journal-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new AgentJournal(root, 'session'); await first.open();
  await first.input('input', 'hash', 'epoch', false);
  for (let index = 0; index < 300; index++) await first.event({ type: 'bytes', channel: 'stdout', data: Buffer.from('🍈'.repeat(1000)).toString('base64') });
  await first.close();
  const { createHash } = await import('node:crypto');
  await appendFile(join(root, '.juiced', 'sessions', createHash('sha256').update('session').digest('hex'), 'events.jsonl'), '{"incomplete');
  const next = new AgentJournal(root, 'session'); await next.open();
  assert.equal(next.latest, 300); assert.equal(next.inputs.get('input')?.delivered, false);
  let after = 0;
  while (after < next.latest) { const page = await next.page(after); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024); after = page.entries.at(-1)!.sequence; }
  assert.equal(after, 300); await next.close();
});

test('a replacement runtime reports interruption and never resends an uncertain native input', async t => {
  const root = await mkdtemp('/tmp/juiced-replacement-'); t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID(), frame: ClaudeFrame = { type: 'user', message: { content: 'May already have changed files' } };
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(JSON.stringify(frame) + '\n').digest('hex');
  const journal = new AgentJournal(root, 'test'); await journal.open();
  await journal.input(id, hash, 'old-process', false);
  await journal.event({ type: 'state', state: 'working' }); await journal.close();
  const controller = new AbortController();
  const service = createDurableAgent({ signal: controller.signal, session: { id: 'test', keepAliveSeconds: 120 }, env: {}, database: async () => { throw Error('unused'); } }, () => { throw Error('Recovery must not start or resend work'); }, root);
  const reply = await service.replay(0);
  assert.ok(reply.ok && reply.replay?.entries.some(entry => entry.event.type === 'reset' && entry.event.interrupted));
  await assert.rejects(service.send({ type: 'agent-input', id, epoch: 'old-process', frame }), /interrupted/);
  await service.dispose();
});

test('durable sessions reject every native session-selection flag, matching local terminal binding', async t => {
  const root = await mkdtemp('/tmp/juiced-flags-'); t.after(() => rm(root, { recursive: true, force: true }));
  const service = createDurableAgent({ signal: new AbortController().signal, session: { id: 'test', keepAliveSeconds: 120 }, env: {}, database: async () => { throw Error('unused'); } }, () => { throw Error('A rejected start must not launch Claude'); }, root);
  t.after(() => service.dispose());
  const start = (argv: string[]) => service.open({ type: 'start', durable: true, tty: false, argv, columns: 80, rows: 24, term: 'xterm-256color' }, {} as SessionContext<TerminalCommand, TerminalEvent, TerminalReply>);
  for (const argv of [['--fork-session'], ['--resume'], ['--resume=abc'], ['-rabc'], ['-c'], ['--continue'], ['--session-id', randomUUID()], ['--from-pr', '1'], ['--teleport']])
    await assert.rejects(start(argv), /Native conversation flags are unavailable/, argv.join(' '));
});
