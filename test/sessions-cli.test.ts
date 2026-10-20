import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { sessionKey } from '../src/runtime/session-list.js';

const execute = promisify(execFile);

test('built sessions command works in a pipe, uses the requested workspace, and never authenticates or starts Claude', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-sessions-cli-'));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
  const output = await mkdtemp(join(projectRoot, '.cantelop', 'sessions-cli-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); });
  await build({ entryPoints: [join(projectRoot, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })], outfile: join(output, 'cli.mjs') });
  const id = `ses_${'1'.repeat(32)}`, workspaceId = `wsp_${'a'.repeat(32)}`;
  const bootstrap = join(output, 'run.mjs');
  await writeFile(bootstrap, `
    import assert from 'node:assert/strict';
    const calls = [];
    process.on('exit', () => process.stderr.write(JSON.stringify(calls)));
    globalThis.fetch = async (input, init) => {
      const body = await new Request(input, init).json();
      calls.push(body.command.type);
      if (body.command.type === 'workspace.inspect') {
        assert.deepEqual(body.workspace, { slug: 'chosen' });
        return Response.json({ protocolVersion: 2, workspace: {
          id: '${workspaceId}', app_id: 'app_' + 'b'.repeat(32), slug: 'chosen', hostname: 'fixture.cantelop.dev',
          created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z'
        } });
      }
      assert.deepEqual(body.workspace, { id: '${workspaceId}' });
      if (body.command.type === 'stop') return Response.json({ protocolVersion: 2, id: body.id });
      assert.equal(body.command.type, 'request');
      assert.equal(body.command.message.type, 'sessions-list');
      return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true, sessions: {
        items: [{ key: '${sessionKey(id)}', id: '${id}', updatedAt: '2026-10-20T12:00:00Z' }], unreadable: 0
      } } });
    };
    await import('./cli.mjs');
  `);
  const env = { ...process.env, CANTELOP_APP_SLUG: 'juiced', CANTELOP_INTEGRATION_TOKEN: 'fixture-token', CANTELOP_EDGE_URL: 'https://fixture.invalid' };
  const listed = await execute(process.execPath, [bootstrap, '--workspace', 'chosen', 'claude', 'sessions'], { cwd: root, env, timeout: 10_000 });
  assert.match(listed.stdout, /Sessions in chosen/); assert.ok(listed.stdout.includes(id));
  assert.match(listed.stdout, /juiced --workspace chosen claude --session ID/);
  assert.deepEqual(JSON.parse(listed.stderr), ['workspace.inspect', 'request', 'stop']);
  const help = await execute(process.execPath, [bootstrap, 'claude', 'sessions', '--help'], { cwd: root, env, timeout: 10_000 });
  assert.match(help.stdout, /claude sessions/); assert.deepEqual(JSON.parse(help.stderr), []);
});
