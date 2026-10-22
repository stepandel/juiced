import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { git } from '../src/git.js';

const execute = promisify(execFile);

// Keep the actual CLI, argument parsing, identity selection, and SDK validation.
// Replace only rendering and network IO so repeated invocations are deterministic.
test('CLI reconnects the same tab, starts fresh on --new, and bypasses bindings for explicit recovery', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-terminal-cli-')));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
  const output = await mkdtemp(join(projectRoot, '.cantelop', 'terminal-cli-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); });
  await build({ entryPoints: [join(projectRoot, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [{ name: 'capture-terminal-selection', setup(builder) {
      builder.onLoad({ filter: /\/src\/tui\/app\.tsx$/ }, () => ({ contents: `export async function runLocalTui(agent, argv) { globalThis.fixtureSession = { id: agent.session.id, argv }; return 0; }`, loader: 'js' }));
      builder.onLoad({ filter: /\/src\/remote-terminal\.ts$/ }, () => ({ contents: `export async function runRemoteTerminal(session, argv) { globalThis.fixtureSession = { id: session.id, argv }; return 0; }`, loader: 'js' }));
    } }, createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })], outfile: join(output, 'cli.mjs') });
  const bootstrap = join(output, 'run.mjs');
  await writeFile(bootstrap, `
    process.stdin.isTTY = process.stdout.isTTY = true;
    globalThis.fixtureOperations = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json();
      globalThis.fixtureOperations.push({ type: body.command.type, workspace: body.workspace });
      if (body.command.type === 'auth') {
        if (process.env.TEST_AUTH_UNAVAILABLE) throw new Error('Auth sandbox unavailable');
        return Response.json({ protocolVersion: 2, id: body.id, reply: { type: 'status', authenticated: !process.env.TEST_SIGN_IN_REQUIRED } });
      }
      if (body.command.type === 'workspace.resolve') return Response.json({
        id: process.env.TEST_WORKSPACE_ID, app_id: 'app_' + 'a'.repeat(32), slug: body.workspace.slug,
        hostname: 'fixture.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z'
      });
      throw new Error('Unexpected network operation: ' + body.command.type);
    };
    await import('./cli.mjs');
    process.stdout.write(JSON.stringify({ ...globalThis.fixtureSession, operations: globalThis.fixtureOperations }) + '\\n');
  `);
  const run = async (argv: string[] = ['claude'], tab = 'tab-a', workspaceId = `wsp_${'1'.repeat(32)}`, env: NodeJS.ProcessEnv = {}) => {
    const { stdout, stderr } = await execute(process.execPath, [bootstrap, ...argv], {
      cwd: root, timeout: 10_000,
      env: { ...process.env, TERM_SESSION_ID: tab, TMUX: '', TMUX_PANE: '', STY: '', WINDOW: '', JUICED_WORKSPACE: 'chosen',
        CANTELOP_APP_SLUG: 'juiced', CANTELOP_INTEGRATION_TOKEN: 'fixture-token', CANTELOP_EDGE_URL: 'https://fixture.invalid', TEST_WORKSPACE_ID: workspaceId, ...env },
    });
    return { ...JSON.parse(stdout) as { id: string; argv: string[]; operations: Array<{ type: string; workspace: { id?: string; slug?: string } }> }, stderr };
  };
  await assert.rejects(run(['--resume', 'claude']), /--resume has been removed/);
  const first = await run(); assert.match(first.id, /^ses_[a-f0-9]{32}$/u);
  assert.deepEqual(first.operations, [
    { type: 'workspace.resolve', workspace: { slug: 'chosen' } },
    { type: 'auth', workspace: { id: `wsp_${'1'.repeat(32)}` } },
  ], 'Resolve once before using the ID for authentication and subsequent Session commands');
  const again = await run(); assert.equal(again.id, first.id); assert.match(again.stderr, /Reconnecting/);
  assert.deepEqual(again.operations, [first.operations[0]], 'Reattachment must not provision the separate authentication sandbox');
  assert.equal((await run(['claude'], 'tab-a', undefined, { TEST_AUTH_UNAVAILABLE: '1' })).id, first.id,
    'An unavailable auth sandbox must not block an existing conversation');
  const other = await run(['claude'], 'tab-b'); assert.notEqual(other.id, first.id);
  assert.deepEqual(other.operations, first.operations, 'A new terminal still checks workspace sign-in');
  const explicit = await run(['claude', '--session', other.id]); assert.equal(explicit.id, other.id);
  assert.deepEqual(explicit.argv, [], 'The Juiced session option must not reach the native Claude process');
  assert.deepEqual(explicit.operations, [first.operations[0]], 'Explicit recovery also bypasses auth preflight');
  const login = await run(['claude', 'login']);
  assert.deepEqual(login.operations, first.operations, 'Explicit login always checks authentication, even with a saved tab binding');
  assert.match(login.stderr, /Ready\. Run juiced/);
  assert.equal((await run()).id, first.id, 'Explicit recovery must preserve this tab’s binding');
  assert.equal((await run(['claude'], 'tab-b')).id, other.id);
  await assert.rejects(run(['claude', '--session', other.id, '-p', 'prompt']), /requires an interactive terminal/);
  await assert.rejects(run(['--session', other.id, 'claude']), /Run juiced claude --session ID/);
  const native = await run(['claude', '--resume', 'native-id']); assert.deepEqual(native.argv, ['--resume', 'native-id']);
  assert.notEqual(native.id, first.id); assert.equal((await run()).id, first.id);
  assert.deepEqual(native.operations, first.operations, 'Native session selection still checks sign-in');
  const printed = await run(['claude', '-p', 'prompt']);
  assert.deepEqual(printed.operations, first.operations, 'Noninteractive launches still check sign-in');
  const help = await run(['claude', '--help']);
  assert.deepEqual(help.operations, [first.operations[0]], 'Claude help must not check authentication');

  // A reattachment must not attempt Git preparation, which would touch a live checkout.
  await git(root, ['init']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial']);
  assert.equal((await run()).id, first.id);
  await rm(join(root, '.git'), { recursive: true, force: true });
  const fresh = await run(['claude', '--new', '--model', 'sonnet']);
  assert.notEqual(fresh.id, first.id); assert.deepEqual(fresh.argv, ['--model', 'sonnet']);
  assert.deepEqual(fresh.operations, first.operations, '--new must still check authentication');
  assert.equal((await run()).id, fresh.id); assert.equal((await run(['claude'], 'tab-b')).id, other.id);
  const recreated = await run(['claude'], 'tab-a', `wsp_${'2'.repeat(32)}`);
  assert.notEqual(recreated.id, fresh.id);
  assert.equal(recreated.operations[1]?.type, 'auth', 'A recreated workspace must check its own credentials');
  const configured = await run(['claude', '--model', 'opus']);
  assert.notEqual(configured.id, fresh.id); assert.deepEqual(configured.argv, ['--model', 'opus']);
  assert.deepEqual(configured.operations, first.operations, 'New launch configuration still checks sign-in');
  assert.equal((await run()).id, configured.id);
  const prompted = await run(['claude', 'Start another task']);
  assert.notEqual(prompted.id, configured.id); assert.deepEqual(prompted.argv, ['Start another task']);
  assert.equal((await run()).id, prompted.id);
  await assert.rejects(run(['claude', '--new'], 'tab-a', undefined, { TEST_SIGN_IN_REQUIRED: '1' }), /Claude sign-in required/);
  assert.equal((await run()).id, prompted.id, 'Failed sign-in must preserve the saved session binding');
  await assert.rejects(run(['claude'], 'signed-out-tab', undefined, { TEST_SIGN_IN_REQUIRED: '1' }), /Claude sign-in required/);
  const signedIn = await run(['claude'], 'signed-out-tab');
  assert.deepEqual(signedIn.operations, first.operations, 'A failed first sign-in must not save a binding that bypasses authentication');
});
