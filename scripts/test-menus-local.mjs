// Model-free compatibility check against an installed Claude binary.
// node --import tsx scripts/test-menus-local.mjs /path/to/claude
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeDecoder } from '../src/agent-protocol.ts';
import { RemoteAgent } from '../src/remote-agent.ts';
import { commandMenu } from '../src/tui/command-menus.ts';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the path to an installed Claude binary. No model prompts will be sent.');
const directory = await mkdtemp(join(tmpdir(), 'juiced-menu-check-'));
await writeFile(join(directory, 'CLAUDE.md'), 'This is a model-free menu compatibility test.\n');
const events = [];
const wake = new EventEmitter();
const decoder = new ClaudeDecoder();
let child;
let diagnostics = '';
let userFrames = 0;
const publish = data => {
  events.push({ cursor: { streamId: 'a'.repeat(32), sequence: events.length + 1 }, data }); wake.emit('output');
};
const session = {
  id: 'local-menu-verification',
  async request(command) {
    assert.equal(command.type, 'start'); assert.equal(command.tty, false);
    child = spawn(resolve(binary), command.argv, {
      cwd: directory,
      // Fresh settings, no inherited API keys, no project hooks or account changes.
      env: { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), CLAUDE_CONFIG_DIR: directory, DISABLE_AUTOUPDATER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', bytes => publish({ type: 'output', channel: 'stdout', data: bytes.toString('base64') }));
    child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-2000); });
    child.on('error', error => publish({ type: 'error', message: error.message }));
    child.on('exit', code => publish({ type: 'exit', code }));
    return { ok: true };
  },
  async dispatch(command) {
    if (command.type !== 'input') return;
    const bytes = Buffer.from(command.data, 'base64');
    for (const frame of decoder.push(bytes)) if (frame.type === 'user') userFrames++;
    assert.equal(userFrames, 0, 'Compatibility checks must never submit a model prompt');
    await new Promise((yes, no) => child.stdin.write(bytes, error => error ? no(error) : yes()));
  },
  async *stream(options) {
    let index = options?.after?.sequence ?? 0;
    while (!options.signal.aborted) {
      if (!events[index]) await once(wake, 'output', { signal: options.signal });
      if (events[index]) yield events[index++];
    }
  },
  async stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await exited; } finally { clearTimeout(timeout); }
  },
};
const agent = new RemoteAgent(session, { controlTimeoutMs: 10_000 });
const deadline = setTimeout(() => { child?.kill('SIGKILL'); }, 45_000);
try {
  await agent.start();
  for (const name of ['model', 'config', 'effort', 'output-style', 'permissions', 'mcp', 'hooks', 'context', 'memory', 'usage', 'agents', 'skills', 'plugin', 'tasks', 'status']) {
    const page = await commandMenu(agent, name);
    assert.ok(page.title);
    console.log(`PASS /${name}: ${page.items.length} entries`);
  }
  const model = agent.models[0];
  assert.ok(model, 'Claude must advertise at least one model');
  await agent.setModel(model.value);
  if (model.supportedEffortLevels?.length) {
    const effort = model.supportedEffortLevels[0];
    await agent.configure({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
    assert.equal((await agent.query({ subtype: 'get_settings' })).applied.effort, effort);
  }
  const style = agent.info.available_output_styles?.[0];
  if (style) {
    await agent.configure({ subtype: 'apply_flag_settings', settings: { outputStyle: style } });
    assert.equal((await agent.query({ subtype: 'get_settings' })).effective.outputStyle, style);
  }
  await agent.configure({ subtype: 'set_permission_mode', mode: 'plan' });
  await agent.configure({ subtype: 'set_permission_mode', mode: 'default' });
  const memory = await agent.query({ subtype: 'read_file', path: join(directory, 'CLAUDE.md'), max_bytes: 32768 });
  assert.ok(memory.contents.includes('model-free menu compatibility test'));
  await agent.configure({ subtype: 'rename_session', title: 'Menu compatibility test' });
  await agent.configure({ subtype: 'reload_skills' });
  await agent.configure({ subtype: 'reload_plugins' });
  assert.equal(userFrames, 0);
  console.log('PASS confirmed changes in the same process; zero model prompts');
} catch (error) {
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  clearTimeout(deadline); await agent.close(); await rm(directory, { recursive: true, force: true });
}
