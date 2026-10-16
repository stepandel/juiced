import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SessionActivationContext, SessionContext, SessionHarnessContext, SessionOutput } from '@cantelop/sdk/session';
import { decodeInput, dimensions, type TerminalCommand, type TerminalEvent, type TerminalReply } from '../protocol.js';
import { PTY_HELPER } from './pty.js';
import { validProjectName } from '../project-name.js';

type Work = { signal: AbortSignal; output: SessionOutput<TerminalEvent> };
type Start = Extract<TerminalCommand, { type: 'start' }>;

function write(stream: Writable, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, error => error ? reject(error) : resolve());
  });
}

function validateStart(command: Start): void {
  dimensions(command.columns, command.rows);
  if (typeof command.tty !== 'boolean' || !Array.isArray(command.argv) ||
      (command.directoryName !== undefined && !validProjectName(command.directoryName)) ||
      command.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      Buffer.byteLength(JSON.stringify(command.argv)) > 64 * 1024 ||
      typeof command.term !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(command.term)) {
    throw new Error('Invalid terminal start command');
  }
}

export function createTerminal(
  context: SessionHarnessContext,
  options: { workspace?: string; binary?: string; python?: string } = {},
) {
  let child: ChildProcess | undefined;
  let control: Writable | undefined;
  let tty = false;
  let started = false;
  let stop: (() => void) | undefined;

  async function input(command: TerminalCommand): Promise<TerminalReply> {
    if (!child || !child.stdin || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The remote terminal is not running');
    }
    switch (command.type) {
      case 'input':
        await write(child.stdin, decodeInput(command.data));
        break;
      case 'eof':
        child.stdin.end();
        break;
      case 'resize':
        dimensions(command.columns, command.rows);
        if (tty) await write(control!, JSON.stringify(command) + '\n');
        break;
      case 'signal':
        if (!['SIGINT', 'SIGTERM', 'SIGHUP'].includes(command.signal)) throw new Error('Invalid terminal signal');
        if (tty) await write(control!, JSON.stringify(command) + '\n');
        else if (child.pid) process.kill(-child.pid, command.signal);
        break;
      case 'heartbeat':
        break;
      default:
        throw new Error('The terminal has already been started');
    }
    return { ok: true };
  }

  async function run(command: Start, work: Work): Promise<TerminalReply> {
    validateStart(command);
    if (started) throw new Error('Each session can start exactly one terminal');
    started = true;
    const signal = AbortSignal.any([context.signal, work.signal]);
    signal.throwIfAborted();
    const workspace = options.workspace ?? process.cwd();
    let workingDirectory = workspace;
    if (command.directoryName !== undefined) {
      try {
        const candidate = join(workspace, command.directoryName);
        const info = await lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== join(await realpath(workspace), command.directoryName)) throw new Error('Unsafe project directory');
        workingDirectory = candidate;
      } catch (cause) {
        const message = 'The synced project directory is unavailable. Restart Juiced to reconcile the project before starting Claude.';
        await work.output.send({ type: 'error', message }).catch(() => {});
        throw new Error(message, { cause });
      }
    }
    await mkdir(join(workspace, '.claude'), { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      HOME: workspace,
      CLAUDE_CONFIG_DIR: join(workspace, '.claude'),
      XDG_CONFIG_HOME: join(workspace, '.config'),
      XDG_DATA_HOME: join(workspace, '.local', 'share'),
      XDG_STATE_HOME: join(workspace, '.local', 'state'),
      XDG_CACHE_HOME: '/tmp/juiced-cache',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: command.term,
      COLORTERM: 'truecolor',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_UPDATES: '1',
    };
    for (const key of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const binary = options.binary ?? context.env.CLAUDE_PATH ?? '/usr/local/bin/claude';
    tty = command.tty;
    const running = tty
      ? spawn(options.python ?? 'python3', ['-u', '-c', PTY_HELPER, String(command.columns), String(command.rows), binary, ...command.argv],
          { cwd: workingDirectory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      : spawn(binary, command.argv, { cwd: workingDirectory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = running;
    control = running.stdio[3] as Writable | undefined;
    running.stdin?.on('error', () => {});
    control?.on('error', () => {});
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!running.pid) return;
      try { process.kill(-running.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    stop = () => {
      if (closed || escalation) return;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 2500);
      escalation.unref();
    };
    const terminate = stop;
    const done = new Promise<number>((resolve, reject) => {
      running.once('error', reject);
      // A tool must not keep the output pipes open after Claude has exited.
      running.once('exit', () => { if (!tty) killGroup('SIGKILL'); });
      running.once('close', (code, exitSignal) => {
        closed = true;
        const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 };
        resolve(code ?? 128 + (signals[exitSignal as keyof typeof signals] ?? 1));
      });
    });
    void done.catch(() => {});
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    const pump = async (stream: Readable, channel: 'stdout' | 'stderr') => {
      for await (const raw of stream) {
        const bytes = Buffer.from(raw as Uint8Array);
        for (let offset = 0; offset < bytes.length; offset += 12 * 1024) {
          await work.output.send({ type: 'output', channel, data: bytes.subarray(offset, offset + 12 * 1024).toString('base64') });
        }
      }
    };
    try {
      await work.output.send({ type: 'ready' });
      await Promise.all([pump(running.stdout!, 'stdout'), pump(running.stderr!, 'stderr')]);
      const code = await done;
      await work.output.send({ type: 'exit', code });
      return { ok: true };
    } catch (error) {
      terminate();
      if (!signal.aborted) {
        const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'The remote image is missing Claude or Python. Rebuild and deploy the Juiced runtime.'
          : 'The remote terminal failed.';
        await work.output.send({ type: 'error', message }).catch(() => {});
      }
      throw error;
    } finally {
      terminate();
      await done.catch(() => {});
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener('abort', terminate);
      stop = undefined;
      child = undefined;
      control = undefined;
    }
  }

  return {
    run,
    input,
    cancel() {
      if (!stop) return false;
      stop();
      return true;
    },
  };
}

// Each Session has its own runtime process and its own terminal instance.
let terminal: ReturnType<typeof createTerminal>;

export function activateTerminal(context: SessionActivationContext<TerminalCommand, TerminalEvent>): void {
  terminal = createTerminal(context);
}

export async function receiveTerminal(context: SessionContext<TerminalCommand, TerminalEvent, TerminalReply>): Promise<void> {
  const command = context.message.payload;
  if (command.type === 'start') {
    validateStart(command);
    context.activity.start(async activity => {
      await terminal.run(command, activity);
    }, { timeoutMs: 90_000, onCancel: () => { terminal.cancel(); } });
  } else {
    try {
      await terminal.input(command);
      context.activity.extend(90_000);
    } catch (error) {
      // Dispatch confirms queue acceptance. Report later delivery failures on
      // the output stream so a local UI never mistakes acceptance for success.
      await context.output.send({ type: 'error', message: 'The remote terminal rejected a command.' });
      throw error;
    }
  }
  context.reply({ ok: true });
}
