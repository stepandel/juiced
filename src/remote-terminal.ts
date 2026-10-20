import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionRef, SessionEventCursor } from '@cantelop/sdk';
import { MAX_INPUT_BYTES, MAX_BUFFERED_INPUT, type TerminalCommand, type TerminalEvent, type TerminalReply } from './protocol.js';
import { backoffMs, isTransient, withTimeout } from './transport.js';

export type TerminalSession = Pick<SessionRef<TerminalCommand, TerminalEvent, TerminalReply>, 'id' | 'request' | 'stream' | 'stop'>;
export type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown };
export type TerminalOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };
export type TerminalIO = { stdin: TerminalInput; stdout: TerminalOutput; stderr: Writable };

function size(stdout: TerminalOutput) {
  return { columns: Math.max(1, Math.min(stdout.columns ?? 80, 1000)), rows: Math.max(1, Math.min(stdout.rows ?? 24, 500)) };
}

async function write(output: Writable, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
}

// Remote-reported terminal failures are final; only the transport is retried.
const retryable = (error: unknown) => !(error instanceof TerminalError) && isTransient(error);

class TerminalError extends Error {}

/** Attach one local terminal to one fresh remote process; never replay input. */
export async function runRemoteTerminal(
  session: TerminalSession,
  argv: string[],
  io: TerminalIO,
  options: { signal?: AbortSignal; term?: string; startupTimeoutMs?: number; heartbeatMs?: number; stopTimeoutMs?: number; inputBatchMs?: number; directoryName?: string; git?: { binding: string; relativeDirectory: string } } = {},
): Promise<number> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const tty = Boolean(io.stdin.isTTY && io.stdout.isTTY);
  const wasRaw = io.stdin.isRaw ?? false;
  const wasPaused = io.stdin.isPaused();
  let attached = false;
  let rawChanged = false;
  let startAttempted = false;
  let exited = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cursor: SessionEventCursor | undefined;
  let pending = Promise.resolve();
  let inputBatches: Buffer[][] = [];
  let textBatch: Buffer[] | undefined;
  let inputBytes = 0;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let inputQueued = false;
  let inputPaused = false;
  const debug = (event: string, detail: object = {}) => {
    if (process.env.JUICED_DEBUG && !io.stderr.destroyed) io.stderr.write(JSON.stringify({ session: session.id, event, ...detail }) + '\n');
  };
  const fail = (error: unknown) => {
    debug('local.failure', { name: (error as Error)?.name, message: (error as Error)?.message });
    if (!signal.aborted && !exited) controller.abort(error);
  };
  const send = async (command: TerminalCommand) => {
    signal.throwIfAborted();
    const startedAt = Date.now();
    debug('control.send', { type: command.type });
    const reply = await withTimeout(signal, 35_000, signal => session.request(command, { timeoutMs: 30_000, signal }));
    debug('control.accepted', { type: command.type, elapsedMs: Date.now() - startedAt });
    if (reply?.ok !== true) throw new Error('The remote terminal rejected input');
  };
  const enqueue = (task: () => Promise<void>) => {
    pending = pending.then(async () => { if (!exited) await task(); });
    void pending.catch(fail);
  };
  const flushInput = () => {
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = undefined;
    if (inputQueued || inputBatches.length === 0 || exited || signal.aborted) return;
    inputQueued = true;
    enqueue(async () => {
      try {
        while (inputBatches.length > 0) {
          // Read at send time: keys typed during an outstanding request travel
          // together instead of creating another request for every data event.
          const batch = inputBatches.shift()!;
          if (batch === textBatch) textBatch = undefined;
          const bytes = Buffer.concat(batch);
          for (let offset = 0; offset < bytes.length; offset += MAX_INPUT_BYTES) {
            const chunk = bytes.subarray(offset, offset + MAX_INPUT_BYTES);
            await send({ type: 'input', data: chunk.toString('base64') });
            inputBytes -= chunk.length;
            if (inputPaused && inputBytes <= MAX_BUFFERED_INPUT / 4 && !signal.aborted && !exited) {
              inputPaused = false;
              io.stdin.resume();
            }
          }
        }
      } finally { inputQueued = false; }
    });
  };
  const onData = (chunk: Buffer | string) => {
    if (signal.aborted || exited) return;
    const bytes = Buffer.from(chunk);
    if (inputBytes + bytes.length > MAX_BUFFERED_INPUT) { fail(new Error('Terminal input exceeded the buffer limit')); return; }
    const urgent = bytes.some(byte => byte < 0x20 || byte === 0x7f);
    if (urgent) {
      // Keep key events separate: text + Enter in one write can be interpreted
      // by a terminal UI as a multiline paste instead of a submitted prompt.
      textBatch = undefined;
      inputBatches.push([bytes]);
    } else {
      if (!textBatch) { textBatch = []; inputBatches.push(textBatch); }
      textBatch.push(bytes);
    }
    inputBytes += bytes.length;
    if (inputBytes >= MAX_BUFFERED_INPUT / 2) {
      inputPaused = true;
      io.stdin.pause();
    }
    // Enter, Escape, backspace and control keys should not wait for the timer.
    if (inputBytes >= MAX_INPUT_BYTES || urgent) flushInput();
    else if (!inputQueued && !inputTimer) {
      // A fixed window, never reset by more typing, bounds added latency.
      inputTimer = setTimeout(flushInput, options.inputBatchMs ?? 8);
    }
  };
  const onEnd = () => { flushInput(); enqueue(() => send({ type: 'eof' })); };
  const onResize = () => { flushInput(); enqueue(() => send({ type: 'resize', ...size(io.stdout) })); };
  const attach = () => {
    if (attached) return;
    attached = true;
    clearTimeout(startup);
    if (tty && io.stdin.setRawMode) {
      io.stdin.setRawMode(true);
      rawChanged = true;
    }
    io.stdin.on('data', onData);
    io.stdin.once('end', onEnd);
    if (tty) { io.stdout.on('resize', onResize); onResize(); }
    if (io.stdin.readableEnded) onEnd();
    else io.stdin.resume();
    heartbeat = setInterval(() => { flushInput(); enqueue(() => send({ type: 'heartbeat' })); }, options.heartbeatMs ?? 30_000);
    heartbeat.unref();
  };
  const startup = setTimeout(() => fail(new Error('Timed out starting Claude on Cantelop')), options.startupTimeoutMs ?? 120_000);
  startup.unref();
  io.stdin.pause();
  io.stdin.on('error', fail);
  io.stdout.on('error', fail);
  io.stderr.on('error', fail);
  try {
    signal.throwIfAborted();
    startAttempted = true;
    await session.request({ type: 'start', argv, tty, ...size(io.stdout), term: options.term ?? 'xterm-256color', ...(options.directoryName ? { directoryName: options.directoryName } : {}), ...(options.git ? { git: options.git } : {}) },
      { timeoutMs: 120_000, signal });
    let failures = 0;
    while (true) {
      signal.throwIfAborted();
      try {
        for await (const event of session.stream({ ...(cursor ? { after: cursor } : {}), signal })) {
          const data = event.data;
          switch (data.type) {
            case 'ready': attach(); break;
            case 'output':
              await write(data.channel === 'stderr' ? io.stderr : io.stdout, Buffer.from(data.data, 'base64'));
              break;
            case 'error': throw new TerminalError(data.message);
            case 'exit':
              if (!Number.isInteger(data.code) || data.code < 0 || data.code > 255) throw new TerminalError('Invalid remote exit code');
              exited = true;
              debug('remote.exit', { code: data.code });
              return data.code;
            default: throw new TerminalError('Unknown remote terminal event');
          }
          cursor = event.cursor;
          failures = 0;
        }
        throw new Error('The output stream ended before Claude exited');
      } catch (error) {
        debug('stream.error', { aborted: signal.aborted, name: (error as Error)?.name, message: (error as Error)?.message });
        if (signal.aborted) throw signal.reason;
        if (!retryable(error) || ++failures > 3) throw error;
        await delay(backoffMs(failures - 1), undefined, { signal });
      }
    }
  } finally {
    exited = true;
    controller.abort();
    clearTimeout(startup);
    if (heartbeat) clearInterval(heartbeat);
    if (inputTimer) clearTimeout(inputTimer);
    inputBatches = [];
    textBatch = undefined;
    io.stdin.pause();
    io.stdin.off('data', onData);
    io.stdin.off('end', onEnd);
    io.stdin.off('error', fail);
    io.stdout.off('resize', onResize);
    if (rawChanged) {
      try { io.stdin.setRawMode!(wasRaw); } catch { /* The local terminal may have closed. */ }
      // Recover terminal modes if a full-screen CLI died mid-render.
      if (!io.stdout.destroyed) await write(io.stdout, Buffer.from('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[0m\x1b[?25h')).catch(() => {});
    }
    io.stdout.off('error', fail);
    io.stderr.off('error', fail);
    if (!wasPaused && io.stdin.listenerCount('data') > 0) io.stdin.resume();
    if (startAttempted) {
      const timeout = AbortSignal.timeout(options.stopTimeoutMs ?? 10_000);
      try {
        await Promise.race([
          session.stop(),
          new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('cleanup timed out')), { once: true })),
        ]);
      } catch {
        io.stderr.write(`juiced: could not release session ${session.id}; its terminal lease expires within 90 seconds.\n`);
      }
    }
  }
}
