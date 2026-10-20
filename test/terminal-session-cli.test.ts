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
test('CLI reconnects the same tab, starts fresh on --new, and bypasses bindings for explicit recovery', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-terminal-cli-')));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
  const output = await mkdtemp(join(projectRoot, '.cantelop', 'terminal-cli-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); });
  await build({ entryPoints: [join(projectRoot, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [{ name: 'capture-terminal-selection', setup(builder) {
      builder.onLoad({ filter: /\/src\/tui\/app\.tsx$/ }, () => ({ contents: `export async function runLocalTui(agent, argv) { process.stdout.write(JSON.stringify({ id: agent.session.id, argv, operations: globalThis.fixtureOperations }) + '\\n'); return 0; }`, loader: 'js' }));
    } }, createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })], outfile: join(output, 'cli.mjs') });
  const bootstrap = join(output, 'run.mjs');
  await writeFile(bootstrap, `
    process.stdin.isTTY = process.stdout.isTTY = true;
    globalThis.fixtureOperations = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json();
      globalThis.fixtureOperations.push({ type: body.command.type, workspace: body.workspace });
      if (body.command.type === 'auth') return Response.json({ protocolVersion: 2, id: body.id, reply: { type: 'status', authenticated: true } });
      if (body.command.type === 'workspace.resolve') return Response.json({
        id: process.env.TEST_WORKSPACE_ID, app_id: 'app_' + 'a'.repeat(32), slug: body.workspace.slug,
        hostname: 'fixture.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z'
      });
      throw new Error('Unexpected network operation: ' + body.command.type);
    };
    await import('./cli.mjs');
  `);
  const run = async (argv: string[] = ['claude'], tab = 'tab-a', workspaceId = `wsp_${'1'.repeat(32)}`) => {
    const { stdout, stderr } = await execute(process.execPath, [bootstrap, ...argv], {
      cwd: root, timeout: 10_000,
      env: { ...process.env, TERM_SESSION_ID: tab, TMUX: '', TMUX_PANE: '', STY: '', WINDOW: '', JUICED_WORKSPACE: 'chosen',
        CANTELOP_APP_SLUG: 'juiced', CANTELOP_INTEGRATION_TOKEN: 'fixture-token', CANTELOP_EDGE_URL: 'https://fixture.invalid', TEST_WORKSPACE_ID: workspaceId },
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
  const other = await run(['claude'], 'tab-b'); assert.notEqual(other.id, first.id);
  const explicit = await run(['--session', other.id, 'claude']); assert.equal(explicit.id, other.id);
  assert.equal((await run()).id, first.id, 'Explicit recovery must preserve this tab’s binding');
  assert.equal((await run(['claude'], 'tab-b')).id, other.id);
  await assert.rejects(run(['--session', other.id, 'claude', '-p', 'prompt']), /requires an interactive terminal/);
  const native = await run(['claude', '--resume', 'native-id']); assert.deepEqual(native.argv, ['--resume', 'native-id']);
  assert.notEqual(native.id, first.id); assert.equal((await run()).id, first.id);

  // A reattachment must not attempt Git preparation, which would touch a live checkout.
  await git(root, ['init']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial']);
  assert.equal((await run()).id, first.id);
  await rm(join(root, '.git'), { recursive: true, force: true });
  const fresh = await run(['claude', '--new', '--model', 'sonnet']);
  assert.notEqual(fresh.id, first.id); assert.deepEqual(fresh.argv, ['--model', 'sonnet']);
  assert.equal((await run()).id, fresh.id); assert.equal((await run(['claude'], 'tab-b')).id, other.id);
  assert.notEqual((await run(['claude'], 'tab-a', `wsp_${'2'.repeat(32)}`)).id, fresh.id);
  const configured = await run(['claude', '--model', 'opus']);
  assert.notEqual(configured.id, fresh.id); assert.deepEqual(configured.argv, ['--model', 'opus']);
  assert.equal((await run()).id, configured.id);
  const prompted = await run(['claude', 'Start another task']);
  assert.notEqual(prompted.id, configured.id); assert.deepEqual(prompted.argv, ['Start another task']);
  assert.equal((await run()).id, prompted.id);
});
