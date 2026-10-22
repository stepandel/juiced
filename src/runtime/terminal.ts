import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SessionActivationContext, SessionContext, SessionHarnessContext, SessionOutput } from '@cantelop/sdk/session';
import { decodeInput, dimensions, OUTPUT_CHUNK_BYTES, type TerminalCommand, type TerminalEvent, type TerminalReply } from '../protocol.js';
import { isENOENT } from '../fs-util.js';
import { PTY_HELPER } from './pty.js';
import { validProjectName } from '../project-name.js';
import { relativeProjectPath } from '../git.js';
import { createGitRuntime, projectPaths, readBinding } from './git.js';
import { acquireCheckout, acquireSessionCheckout, CheckoutBusy } from './project-state.js';
import { captureRemoteInspection, inspectRemote, sendInspection } from './inspection.js';
import { INSPECTION_TIMEOUT_MS, MAX_INSPECTION_REPLY_BYTES, validateInspectionCommand } from '../inspection-protocol.js';
import { saveSettings } from './settings.js';
import { createDurableAgent } from './durable-agent.js';
import { listRemoteSessions } from './session-list.js';
import { createPublishBridge } from './publish.js';
import { validOid } from '../git-protocol.js';

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
      (command.durable !== undefined && typeof command.durable !== 'boolean') ||
      (command.localPublish !== undefined && (!command.durable || !command.git || !validOid(command.localPublish))) ||
      (command.directoryName !== undefined && !validProjectName(command.directoryName)) ||
      (command.git !== undefined && (!command.directoryName || !/^[a-f0-9]{64}$/.test(command.git.binding) || !relativeProjectPath(command.git.relativeDirectory))) ||
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
  let preparing: Promise<void> | undefined;
  let prepared: (() => void) | undefined;
  let prepareFailed: ((error: unknown) => void) | undefined;
  let publisher: Awaited<ReturnType<typeof createPublishBridge>> | undefined;

  async function input(command: TerminalCommand): Promise<TerminalReply> {
    // Startup can wait for shared checkout ownership and database credentials.
    // Intake may already have accepted the client's initialization frame.
    if (!child && preparing) await preparing;
    if (!child || !child.stdin || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The remote terminal is not running');
    }
    switch (command.type) {
      case 'publish-status': case 'publish-claim': case 'publish-result':
        if (!publisher) throw new Error('The local publication bridge is unavailable.');
        { const result = await publisher.input(command); return { ok: true, ...(result ? { publication: result } : {}) }; }
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
      case 'save-settings':
        try { await saveSettings(options.workspace ?? process.cwd(), command.settings, context.signal); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Unable to save Claude settings' }; }
        break;
      default:
        throw new Error('The terminal has already been started');
    }
    return { ok: true };
  }

  async function runTerminal(command: Start, work: Work): Promise<TerminalReply> {
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
        const message = 'The remote project directory is unavailable or unsafe.';
        await work.output.send({ type: 'error', message }).catch(() => {});
        throw new Error(message, { cause });
      }
    }
    if (command.git?.relativeDirectory) {
      const candidate = join(workingDirectory, command.git.relativeDirectory);
      if (await realpath(candidate) !== candidate || !(await lstat(candidate)).isDirectory()) throw new Error('Unsafe Git project working directory');
      workingDirectory = candidate;
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
    if (context.env.GH_TOKEN) {
      env.GH_TOKEN = context.env.GH_TOKEN;
      env.GH_PROMPT_DISABLED = '1';
      env.GIT_TERMINAL_PROMPT = '0';
      // Empty first entry resets inherited helpers; the second uses the token from the environment.
      env.GIT_CONFIG_COUNT = '2';
      env.GIT_CONFIG_KEY_0 = env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper';
      env.GIT_CONFIG_VALUE_0 = '';
      env.GIT_CONFIG_VALUE_1 = '!gh auth git-credential';
    }
    const binary = options.binary ?? context.env.CLAUDE_PATH ?? '/usr/local/bin/claude';
    let argv = command.argv;
    if (command.localPublish && command.git && command.directoryName) {
      publisher = await createPublishBridge(context, { workspace, directoryName: command.directoryName, binding: command.git.binding, known: command.localPublish, relativeDirectory: command.git.relativeDirectory, send: event => work.output.send(event) });
      argv = [...argv, '--mcp-config', publisher.configuration];
    }
    tty = command.tty;
    const running = tty
      ? spawn(options.python ?? 'python3', ['-u', '-c', PTY_HELPER, String(command.columns), String(command.rows), binary, ...argv],
          { cwd: workingDirectory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      : spawn(binary, argv, { cwd: workingDirectory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = running;
    prepared?.();
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
        for (let offset = 0; offset < bytes.length; offset += OUTPUT_CHUNK_BYTES) {
          await work.output.send({ type: 'output', channel, data: bytes.subarray(offset, offset + OUTPUT_CHUNK_BYTES).toString('base64') });
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
        const message = isENOENT(error)
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
    async run(command: Start, work: Work): Promise<TerminalReply> {
      validateStart(command);
      if (preparing) throw new Error('Each session can start exactly one terminal');
      preparing = new Promise<void>((resolve, reject) => { prepared = resolve; prepareFailed = reject; });
      void preparing.catch(() => {});
      const workspace = options.workspace ?? process.cwd();
      const controller = new AbortController();
      let lease: Awaited<ReturnType<typeof acquireCheckout>> | undefined;
      try {
        if (command.directoryName) {
          let paths;
          try { paths = await projectPaths(workspace, command.directoryName); }
          catch (error) { await work.output.send({ type: 'error', message: 'The project directory is unavailable or unsafe.' }).catch(() => {}); throw error; }
          if (command.git) {
            lease = await acquireSessionCheckout(await context.database(), command.directoryName, context.session.id, AbortSignal.any([context.signal, work.signal]), error => { controller.abort(error); stop?.(); });
            const binding = await readBinding(paths.metadata);
            if (binding?.binding !== command.git.binding) throw new Error('The Git workspace binding changed. Reconnect with Juiced.');
            const gitInfo = await lstat(join(paths.target, '.git'));
            if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) throw new Error('Unsafe Git workspace directory');
          } else {
            if (await readBinding(paths.metadata)) throw new Error('This Git workspace requires a matching Juiced Git session. Rebuild the local CLI.');
            await mkdir(paths.target).catch(error => { if (error.code !== 'EEXIST') throw error; });
          }
        }
        return await runTerminal(command, { ...work, signal: AbortSignal.any([work.signal, controller.signal]) });
      } catch (error) { prepareFailed?.(error); throw error; }
      finally {
        // The checkout lease must be released even if tearing down the bridge fails.
        try { await publisher?.close(); }
        finally { publisher = undefined; await lease?.release(); }
      }
    },
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
let gitRuntime: ReturnType<typeof createGitRuntime>;
let agent: ReturnType<typeof createDurableAgent>;

export async function activateTerminal(context: SessionActivationContext<TerminalCommand, TerminalEvent>): Promise<void> {
  await agent?.dispose();
  terminal = createTerminal(context);
  gitRuntime = createGitRuntime(context);
  agent = createDurableAgent(context, () => createTerminal(context));
}

export async function receiveTerminal(context: SessionContext<TerminalCommand, TerminalEvent, TerminalReply>): Promise<void> {
  const command = context.message.payload;
  if (command.type === 'sessions-list') {
    try { context.reply({ ok: true, sessions: await listRemoteSessions(command, context.signal) }); }
    catch (error) { context.reply({ ok: false, error: error instanceof Error ? error.message : 'Session listing failed' }); }
    return;
  }
  if (command.type === 'agent-replay' || command.type === 'agent-input' || command.type === 'start' && command.durable) {
    try {
      if (command.type === 'start') { validateStart(command); context.reply(await agent.open(command, context)); }
      else if (command.type === 'agent-replay') {
        if (command.stream !== undefined) { await agent.streamReplay(command.after, command.stream, context); context.reply({ ok: true }); }
        else context.reply(await agent.replay(command.after));
      }
      else { await agent.send(command); context.reply({ ok: true }); }
    } catch (error) { context.reply({ ok: false, error: error instanceof Error ? error.message : 'Durable agent operation failed' }); }
    return;
  }
  if (command.type === 'save-settings' && agent.active) {
    try { context.reply(await agent.input(command)); }
    catch (error) { context.reply({ ok: false, error: error instanceof Error ? error.message : 'Unable to save Claude settings' }); }
    return;
  }
  if (command.type === 'publish-status' || command.type === 'publish-claim' || command.type === 'publish-result') {
    try { context.reply(await agent.input(command)); }
    catch (error) { context.reply({ ok: false, error: error instanceof Error ? error.message : 'Local publication failed' }); }
    return;
  }
  if (command.type === 'inspect') {
    validateInspectionCommand(command);
    if (command.inline) {
      try {
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(INSPECTION_TIMEOUT_MS)]);
        const snapshot = await captureRemoteInspection(command, signal);
        const reply = { ok: true as const, inspection: snapshot };
        if (Buffer.byteLength(JSON.stringify(reply)) <= MAX_INSPECTION_REPLY_BYTES) {
          context.reply(reply);
          return;
        }
        // Capture once; stream larger inventories using the existing bounded protocol.
        context.activity.queue(async activity => {
          try { await sendInspection(command, snapshot, activity.output, activity.signal); }
          catch (error) {
            if (activity.signal.aborted) throw error;
            await activity.output.send({ type: 'inspection-error', id: command.id, message: error instanceof Error ? error.message : 'Workspace inspection failed' });
          }
          await activity.view.commit({ inspection: 1 });
        }, { timeoutMs: INSPECTION_TIMEOUT_MS });
        context.reply({ ok: true });
      } catch (error) {
        if (context.signal.aborted) throw error;
        context.reply({ ok: false, error: error instanceof Error ? error.message : 'Workspace inspection failed' });
      }
      return;
    }
    context.activity.queue(async activity => {
      await inspectRemote(command, activity.output, activity.signal);
      await activity.view.commit({ inspection: 1 });
    }, { timeoutMs: INSPECTION_TIMEOUT_MS });
    context.reply({ ok: true });
    return;
  }
  if (command.type === 'git') {
    try {
      if (command.action === 'download') {
        context.activity.start(async activity => {
          try { await gitRuntime.handle(command, activity.output, activity.signal); }
          catch (error) { await activity.output.send({ type: 'git-error', id: command.id, message: error instanceof Error ? error.message : 'Git download failed' }); }
        }, { timeoutMs: 240_000 });
        context.reply({ ok: true });
      } else context.reply({ ok: true, git: await gitRuntime.handle(command) });
    } catch (error) {
      context.reply({ ok: false, error: error instanceof Error ? error.message : 'Git workspace operation failed', ...(error instanceof CheckoutBusy ? { busy: error.kind, ...(error.stale.length ? { stale: error.stale } : {}) } : {}) });
    }
    return;
  }
  if (command.type === 'start') {
    validateStart(command);
    context.activity.start(async activity => {
      try { await terminal.run(command, activity); }
      catch (error) { if (!activity.signal.aborted) await activity.output.send({ type: 'error', message: error instanceof Error ? error.message : 'Remote terminal failed' }); throw error; }
    }, { timeoutMs: 90_000, onCancel: () => { terminal.cancel(); } });
  } else {
    try {
      const reply = await terminal.input(command);
      context.activity.extend(90_000);
      context.reply(reply);
      return;
    } catch (error) {
      // Dispatch confirms queue acceptance. Report later delivery failures on
      // the output stream so a local UI never mistakes acceptance for success.
      await context.output.send({ type: 'error', message: 'The remote terminal rejected a command.' });
      throw error;
    }
  }
  context.reply({ ok: true });
}
