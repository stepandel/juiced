import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

const execute = promisify(execFile);

test('built github-configure CLI uses the app API without a workspace, Claude login, or Cantelop CLI', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-github-cli-'));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
  const output = await mkdtemp(join(projectRoot, '.cantelop', 'github-cli-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); });
  await build({ entryPoints: [join(projectRoot, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })], outfile: join(output, 'cli.mjs') });
  const bootstrap = join(output, 'run.mjs');
  await writeFile(bootstrap, `
    import assert from 'node:assert/strict';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://api.github.com/user') {
        assert.equal(request.headers.get('Authorization'), 'Bearer ' + process.env.TEST_EXPECTED_TOKEN);
        calls.push('github-verify');
        return process.env.TEST_REJECT_TOKEN ? new Response('fixture-token', { status: 401 }) : Response.json({ login: 'octocat' });
      }
      assert.equal(new URL(request.url).origin, 'https://fixture.invalid');
      assert.equal(request.headers.get('Authorization'), 'Bearer fixture-app-token');
      const body = await request.json();
      assert.equal(body.workspace, null);
      assert.equal(body.session, null);
      assert.equal(new URL(request.url).pathname, '/commands/' + body.command.type);
      calls.push(body.command.type);
      if (body.command.type === 'app.environment.set') {
        assert.equal(body.command.name, 'GH_TOKEN');
        assert.equal(body.command.value, process.env.TEST_EXPECTED_TOKEN);
        assert.equal(body.command.secret, true);
      } else assert.equal(body.command.type, 'app.environment.status');
      return Response.json({ protocolVersion: 2, id: body.id, revision: 4, status: body.command.type === 'app.environment.set' ? 'pending' : 'applied' });
    };
    process.on('exit', () => process.stdout.write(JSON.stringify(calls) + '\\n'));
    await import('./cli.mjs');
  `);
  const env = { PATH: '', HOME: root, CANTELOP_APP_SLUG: 'juiced', CANTELOP_INTEGRATION_TOKEN: 'fixture-app-token',
    CANTELOP_EDGE_URL: 'https://fixture.invalid', JUICED_WORKSPACE: 'ignored-project', TEST_EXPECTED_TOKEN: 'fixture-token' };
  const configuredCalls = ['github-verify', 'app.environment.set', 'app.environment.status'];
  const savedDirectory = join(root, '.cantelop', 'juiced');
  await mkdir(savedDirectory, { recursive: true });
  const savedSession = JSON.stringify({ workspace: 'existing-project', id: `ses_${'7'.repeat(32)}` });
  await writeFile(join(savedDirectory, 'existing-session.json'), savedSession);

  const existing = await execute(process.execPath, [bootstrap, 'claude', 'github-configure'], {
    cwd: root, env: { ...env, GH_TOKEN: 'fixture-token' }, timeout: 5000,
  });
  assert.deepEqual(JSON.parse(existing.stdout), configuredCalls);
  assert.match(existing.stderr, /Authenticated with GitHub as octocat/);
  assert.match(existing.stderr, /\[1\/3\].*Finding.*\[2\/3\].*Verifying.*\[3\/3\].*Saving/s);
  assert.match(existing.stderr, /same terminal tab.*juiced claude/);
  assert.doesNotMatch(existing.stderr, /fixture-token|Claude sign-in required|Preparing Git workspace|Connecting to Cantelop workspace|--new/);
  assert.deepEqual(await readdir(savedDirectory), ['existing-session.json']);
  assert.equal(await readFile(join(savedDirectory, 'existing-session.json'), 'utf8'), savedSession, 'Setup must preserve the saved conversation binding');

  const piped = spawn(process.execPath, [bootstrap, 'claude', 'github-configure', '--stdin'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  piped.stdout.on('data', bytes => { stdout += bytes; }); piped.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise<number | null>((resolve, reject) => { piped.once('close', resolve); piped.once('error', reject); });
  const timeout = setTimeout(() => piped.kill('SIGKILL'), 5000);
  piped.stdin.end('fixture-token\n');
  try { assert.equal(await closed, 0, stderr); } finally { clearTimeout(timeout); }
  assert.deepEqual(JSON.parse(stdout), configuredCalls);
  assert.doesNotMatch(stderr, /fixture-token/);

  // Exercise the real subprocess path with an isolated fake gh; credentials must
  // never appear in process arguments or forwarded subprocess diagnostics.
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nimport assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['auth', 'token', '--hostname', 'github.com']);\nassert.equal(process.env.GH_PROMPT_DISABLED, '1');\nassert.equal(process.env.GH_DEBUG, '');\nprocess.stdout.write('fixture-token\\n');\nprocess.stderr.write('fixture-token must stay private\\n');\n`, { mode: 0o755 });
  const local = await execute(process.execPath, [bootstrap, 'claude', 'github-configure'], {
    cwd: root, env: { ...env, PATH: bin }, timeout: 5000,
  });
  assert.deepEqual(JSON.parse(local.stdout), configuredCalls);
  assert.match(local.stderr, /local gh credential/);
  assert.doesNotMatch(local.stderr, /fixture-token|must stay private/);

  await assert.rejects(execute(process.execPath, [bootstrap, 'claude', 'github-configure'], {
    cwd: root, env: { ...env, GH_TOKEN: 'fixture-token', TEST_REJECT_TOKEN: '1' }, timeout: 5000,
  }), (error: unknown) => {
    const result = error as { stdout: string; stderr: string; code: number };
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), ['github-verify']);
    assert.match(result.stderr, /GitHub rejected the token/);
    assert.doesNotMatch(result.stderr, /fixture-token|GitHub configured/);
    return true;
  });
  const help = await execute(process.execPath, [bootstrap, 'claude', 'github-configure', '--help'], { cwd: root, env, timeout: 5000 });
  assert.match(help.stdout, /Usage: juiced claude github-configure/);
  assert.ok(help.stdout.endsWith('[]\n'), 'Help must not access GitHub or Cantelop');
  assert.equal(help.stderr, '');
});
