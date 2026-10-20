import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CantelopClient, type AppCommandEnvelope, type SessionEvent, type SessionEventCursor } from '@cantelop/sdk';
import { createTerminal } from '../src/runtime/terminal.js';
import { runRemoteTerminal, type TerminalInput, type TerminalOutput, type TerminalSession } from '../src/remote-terminal.js';
import { MAX_INPUT_BYTES, type TerminalCommand, type TerminalEvent } from '../src/protocol.js';

function capture(tty = false) {
  const bytes: Buffer[] = [];
  const stream: TerminalOutput = new Writable({ write(chunk, _, callback) { bytes.push(Buffer.from(chunk)); callback(); } });
  stream.isTTY = tty;
  stream.columns = 80;
  stream.rows = 24;
  return { stream, bytes, text: () => Buffer.concat(bytes).toString() };
}

function input(tty = false) {
  const stdin = new PassThrough() as PassThrough & TerminalInput;
  stdin.isTTY = tty;
  stdin.isRaw = false;
  const raw: boolean[] = [];
  stdin.setRawMode = value => { raw.push(value); stdin.isRaw = value; };
  return { stdin, raw };
}

function event(data: TerminalEvent, sequence: number): SessionEvent<TerminalEvent> {
  return { cursor: { streamId: 'a'.repeat(32), sequence }, sessionId: 'test', messageId: `msg_${'1'.repeat(32)}`, createdAt: new Date(), data };
}

test('real SDK transport streams a remote subprocess and preserves piped bytes, stderr and exit status', { timeout: 10_000 }, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'juiced-sdk-test-')));
  const lifetime = new AbortController();
  const terminal = createTerminal({ signal: lifetime.signal, session: { id: 'test', keepAliveSeconds: 120 }, env: {}, database: async () => { throw new Error('unused'); } }, { workspace, binary: process.execPath });
  const events: SessionEvent<TerminalEvent>[] = [];
  const emitted = new EventEmitter();
  let running = Promise.resolve();
  let stops = 0;
  const commands: TerminalCommand[] = [];
  const app = new CantelopClient().app<TerminalCommand, TerminalEvent, { ok: true }>({
    name: 'juiced-test',
    runtime: { receive() {} },
    connection: {
      async fetch(request) {
        const envelope = await request.json() as AppCommandEnvelope<TerminalCommand>;
        const command = envelope.command;
        if (command.type === 'request') {
          commands.push(command.message);
          if (command.message.type === 'start') {
            running = terminal.run(command.message, { signal: lifetime.signal, output: { async send(data) { events.push(event(data, events.length + 1)); emitted.emit('event'); } } }).then(() => {});
          } else await terminal.input(command.message);
          return Response.json({ protocolVersion: 2, id: envelope.id, reply: { ok: true } });
        }
        if (command.type === 'stream') {
          let index = command.after?.sequence ?? 0;
          const abort = new AbortController();
          const signal = AbortSignal.any([request.signal, abort.signal]);
          return new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
              while (!events[index]) await once(emitted, 'event', { signal });
              const next = events[index++]!;
              const document = { stream_id: next.cursor.streamId, sequence: next.cursor.sequence, session_id: 'test', message_id: next.messageId, created_at: next.createdAt.toISOString(), data: next.data };
              controller.enqueue(new TextEncoder().encode(`id: ${next.cursor.streamId}:${next.cursor.sequence}\ndata: ${JSON.stringify(document)}\n\n`));
            },
            cancel() { abort.abort(); },
          }), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (command.type === 'stop') {
          stops++;
          terminal.cancel();
          await running;
          return Response.json({ protocolVersion: 2, id: envelope.id });
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
    },
  });
  t.after(async () => { lifetime.abort(); terminal.cancel(); await running.catch(() => {}); await rm(workspace, { recursive: true, force: true }); });
  const stdout = capture();
  const stderr = capture();
  const { stdin } = input();
  stdin.end(Buffer.from('A prompt with 🍈 and \x00 binary\n'));
  const session = app.workspace({ slug: 'default' }).session({ id: 'test', keepAliveSeconds: 120 });
  const code = await runRemoteTerminal(session, ['-e', `process.stderr.write('diagnostic\\n'); process.stdin.pipe(process.stdout); process.stdin.on('end',()=>process.exitCode=9);`], { stdin, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(code, 9);
  assert.equal(stdout.text(), 'A prompt with 🍈 and \x00 binary\n');
  assert.equal(stderr.text(), 'diagnostic\n');
  assert.equal(stops, 1);
  assert.equal(commands.filter(command => command.type === 'start').length, 1);
  assert.equal(commands.at(-1)?.type, 'eof');
});

test('restores raw mode and stops the session when a stream fails', { timeout: 5000 }, async () => {
  const { stdin, raw } = input(true);
  const stdout = capture(true);
  const stderr = capture();
  let stops = 0;
  const session: TerminalSession = {
    id: 'test',
    async request() { return { ok: true }; },
    async *stream() { yield event({ type: 'ready' }, 1); throw new Error('invalid protocol'); },
    async stop() { stops++; },
  };
  await assert.rejects(runRemoteTerminal(session, [], { stdin, stdout: stdout.stream, stderr: stderr.stream }), /invalid protocol/);
  assert.deepEqual(raw, [true, false]);
  assert.equal(stdin.isRaw, false);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.stream.listenerCount('resize'), 0);
  assert.equal(stops, 1);
  assert.match(stdout.text(), /\x1b\[\?25h/);
});

test('resumes a dropped output stream from its cursor without repeating the start or input', { timeout: 5000 }, async () => {
  const { stdin } = input();
  const stdout = capture();
  const stderr = capture();
  const cursors: Array<SessionEventCursor | undefined> = [];
  const requests: TerminalCommand[] = [];
  const session: TerminalSession = {
    id: 'test',
    async request(command) { requests.push(command); return { ok: true }; },
    async *stream(options) {
      cursors.push(options?.after);
      if (cursors.length === 1) {
        yield event({ type: 'ready' }, 1);
        yield event({ type: 'output', channel: 'stdout', data: Buffer.from('first').toString('base64') }, 2);
        throw new TypeError('network connection lost');
      }
      yield event({ type: 'output', channel: 'stdout', data: Buffer.from('second').toString('base64') }, 3);
      yield event({ type: 'exit', code: 0 }, 4);
    },
    async stop() {},
  };
  assert.equal(await runRemoteTerminal(session, [], { stdin, stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stdout.text(), 'firstsecond');
  assert.deepEqual(cursors, [undefined, { streamId: 'a'.repeat(32), sequence: 2 }]);
  assert.equal(requests.filter(command => command.type === 'start').length, 1);
});

test('cleans up an ambiguously failed start and times out a terminal that never becomes ready', { timeout: 5000 }, async () => {
  const { stdin } = input();
  let stops = 0;
  const session: TerminalSession = {
    id: 'test',
    async request() { throw new Error('connection failed after acceptance'); },
    async *stream() {},
    async stop() { stops++; },
  };
  const io = { stdin, stdout: capture().stream, stderr: capture().stream };
  await assert.rejects(runRemoteTerminal(session, [], io), /after acceptance/);
  assert.equal(stops, 1);
  session.request = async () => ({ ok: true });
  session.stream = async function* (options) {
    await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
  };
  // The startup timer is unref'd (a real terminal keeps the process alive), so hold the loop open.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(runRemoteTerminal(session, [], io, { startupTimeoutMs: 20 }), /Timed out/);
  } finally { clearInterval(keepAlive); }
  assert.equal(stops, 2);
});

test('reconnects when the network aborts the stream while the local session is still active', { timeout: 5000 }, async () => {
  const { stdin } = input();
  let streams = 0;
  let starts = 0;
  const session: TerminalSession = {
    id: 'test',
    async request() { starts++; return { ok: true }; },
    async *stream(options) {
      if (++streams === 1) {
        yield event({ type: 'ready' }, 1);
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      assert.deepEqual(options?.after, { streamId: 'a'.repeat(32), sequence: 1 });
      yield event({ type: 'exit', code: 0 }, 2);
    },
    async stop() {},
  };
  assert.equal(await runRemoteTerminal(session, [], { stdin, stdout: capture().stream, stderr: capture().stream }), 0);
  assert.equal(streams, 2);
  assert.equal(starts, 1);
});

test('forwards Ctrl-C as terminal input and stops and restores on external cancellation', { timeout: 5000 }, async () => {
  const { stdin, raw } = input(true);
  const stdout = capture(true);
  const controller = new AbortController();
  let received = false;
  let stops = 0;
  const session: TerminalSession = {
    id: 'test',
    async request(command) {
      if (command.type === 'input') {
        assert.deepEqual(Buffer.from(command.data, 'base64'), Buffer.from([3]));
        received = true;
        controller.abort(new Error('shutdown'));
      }
      return { ok: true };
    },
    async *stream(options) {
      yield event({ type: 'ready' }, 1);
      stdin.write(Buffer.from([3]));
      await new Promise((_, reject) => {
        if (options?.signal?.aborted) reject(options.signal.reason);
        else options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    },
    async stop() { stops++; },
  };
  await assert.rejects(runRemoteTerminal(session, [], { stdin, stdout: stdout.stream, stderr: capture().stream }, { signal: controller.signal }), /shutdown/);
  assert.equal(received, true);
  assert.deepEqual(raw, [true, false]);
  assert.equal(stops, 1);
});

test('coalesces keys typed during a request and preserves their bytes before EOF', { timeout: 5000 }, async () => {
  const { stdin } = input();
  const inputs: Buffer[] = [];
  let releaseFirst!: () => void;
  let startedFirst!: () => void;
  let receivedEOF!: () => void;
  const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  const eof = new Promise<void>(resolve => { receivedEOF = resolve; });
  const session: TerminalSession = {
    id: 'test',
    async request(command) {
      if (command.type === 'input') {
        inputs.push(Buffer.from(command.data, 'base64'));
        if (inputs.length === 1) { startedFirst(); await firstReleased; }
      }
      if (command.type === 'eof') receivedEOF();
      return { ok: true };
    },
    async *stream() {
      yield event({ type: 'ready' }, 1);
      stdin.write('a');
      await firstStarted;
      assert.equal(stdin.isPaused(), false, 'normal typing should continue while a request is outstanding');
      stdin.write('bc');
      stdin.write(Buffer.from([0xf0, 0x9f]));
      stdin.write(Buffer.from([0x8d, 0x88]));
      stdin.end('de');
      releaseFirst();
      await eof;
      yield event({ type: 'exit', code: 0 }, 2);
    },
    async stop() {},
  };
  assert.equal(await runRemoteTerminal(session, [], { stdin, stdout: capture().stream, stderr: capture().stream }), 0);
  assert.equal(inputs.length, 2);
  assert.equal(Buffer.concat(inputs).toString(), 'abc🍈de');
});

test('control keys flush pending text without waiting for the batching window', { timeout: 5000 }, async () => {
  const { stdin } = input();
  const inputs: Buffer[] = [];
  let receivedInput!: () => void;
  let receivedEOF!: () => void;
  const inputReceived = new Promise<void>(resolve => { receivedInput = resolve; });
  const eof = new Promise<void>(resolve => { receivedEOF = resolve; });
  const session: TerminalSession = {
    id: 'test',
    async request(command) {
      if (command.type === 'input') { inputs.push(Buffer.from(command.data, 'base64')); receivedInput(); }
      if (command.type === 'eof') receivedEOF();
      return { ok: true };
    },
    async *stream() {
      yield event({ type: 'ready' }, 1);
      stdin.write('pending');
      stdin.write(Buffer.from([3]));
      stdin.write('after');
      stdin.write('\r');
      await Promise.race([inputReceived, delay(100).then(() => { throw new Error('Ctrl-C waited for the batch timer'); })]);
      stdin.end();
      await eof;
      yield event({ type: 'exit', code: 0 }, 2);
    },
    async stop() {},
  };
  assert.equal(await runRemoteTerminal(session, [], { stdin, stdout: capture().stream, stderr: capture().stream }, { inputBatchMs: 1000 }), 0);
  assert.deepEqual(inputs, [Buffer.from('pending'), Buffer.from([3]), Buffer.from('after'), Buffer.from('\r')]);
});

test('a large paste respects remote frame limits and drains before EOF', { timeout: 5000 }, async () => {
  const { stdin } = input();
  const payload = Buffer.alloc(MAX_INPUT_BYTES * 40 + 3, 0x61);
  const inputs: Buffer[] = [];
  let receivedEOF!: () => void;
  const eof = new Promise<void>(resolve => { receivedEOF = resolve; });
  const session: TerminalSession = {
    id: 'test',
    async request(command) {
      if (command.type === 'input') inputs.push(Buffer.from(command.data, 'base64'));
      if (command.type === 'eof') receivedEOF();
      return { ok: true };
    },
    async *stream() {
      yield event({ type: 'ready' }, 1);
      stdin.end(payload);
      await eof;
      yield event({ type: 'exit', code: 0 }, 2);
    },
    async stop() {},
  };
  assert.equal(await runRemoteTerminal(session, [], { stdin, stdout: capture().stream, stderr: capture().stream }), 0);
  assert.ok(inputs.every(bytes => bytes.length <= MAX_INPUT_BYTES));
  assert.deepEqual(Buffer.concat(inputs), payload);
});

test('discards an unsent batch when the remote process exits', { timeout: 5000 }, async () => {
  const { stdin } = input();
  let inputs = 0;
  const session: TerminalSession = {
    id: 'test',
    async request(command) { if (command.type === 'input') inputs++; return { ok: true }; },
    async *stream() {
      yield event({ type: 'ready' }, 1);
      stdin.write('pending');
      yield event({ type: 'exit', code: 0 }, 2);
    },
    async stop() {},
  };
  await runRemoteTerminal(session, [], { stdin, stdout: capture().stream, stderr: capture().stream }, { inputBatchMs: 20 });
  await delay(30);
  assert.equal(inputs, 0);
});
