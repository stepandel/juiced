import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { CantelopClient } from '@cantelop/sdk';
import { syncFiles } from '../src/file-sync.js';
import { selectProject } from '../src/project.js';

// Only the remote transport is a fixture. Local files and persistent baselines
// use the SDK's native adapter, without the Cantelop CLI or a Claude process.
test('explicit file sync and CLI watch transfer both ways, preserve conflicts and stop cleanly', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-file-sync-sdk-'));
  const previous = process.env.CANTELOP_SYNC_STATE_HOME;
  process.env.CANTELOP_SYNC_STATE_HOME = join(root, 'state');
  t.after(async () => { if (previous === undefined) delete process.env.CANTELOP_SYNC_STATE_HOME; else process.env.CANTELOP_SYNC_STATE_HOME = previous; await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'My Project'); await mkdir(directory);
  const project = await selectProject(directory), id = `wsp_${'a'.repeat(32)}`;
  const hash = (data: Buffer) => createHash('sha256').update(Buffer.from([0])).update(data).digest('hex');
  const entry = (path: string, data: Buffer) => ({ path, version: hash(data), size: data.length, executable: false });
  const files = new Map([['remote.txt', Buffer.from('remote project file')]]);
  const fetchFixture = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/commands/workspace.resolve') return Response.json({ id, app_id: `app_${'b'.repeat(32)}`, slug: project.workspace,
      hostname: 'fixture.example', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' });
    assert.equal(url.pathname, `/__cantelop/sync/workspaces/${id}`);
    assert.equal(url.searchParams.get('root'), project.directoryName);
    const op = url.searchParams.get('op'), name = url.searchParams.get('path')!;
    if (op === 'scan') return Response.json({ protocolVersion: 1, root: project.directoryName, writes: true, entries: [...files].map(([name, data]) => entry(name, data)) });
    const previous = files.get(name);
    assert.equal(url.searchParams.get('base'), previous ? hash(previous) : 'missing');
    if (op === 'read') return new Response(previous!);
    if (op === 'write') { const data = Buffer.from(await request.arrayBuffer()); files.set(name, data); return Response.json(entry(name, data)); }
    if (op === 'remove') { files.delete(name); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected sync operation: ${op}`);
  };
  const app = new CantelopClient().app({ name: 'sync-test', runtime: { receive() {} }, connection: { fetch: fetchFixture } });
  const workspace = app.workspace({ slug: project.workspace }), stderr = new Writable({ write(_bytes, _encoding, callback) { callback(); } });
  const run = () => syncFiles(workspace, project, false, new AbortController().signal, stderr);
  await writeFile(join(directory, 'README.md'), 'local project'); await writeFile(join(directory, '.env'), 'excluded secret');
  await mkdir(join(directory, 'dist')); await writeFile(join(directory, 'dist', 'output.js'), 'excluded build');
  await run();
  assert.equal(files.get('README.md')!.toString(), 'local project');
  assert.equal(files.has('.env'), false); assert.equal(files.has('dist/output.js'), false);
  assert.equal(await readFile(join(directory, 'remote.txt'), 'utf8'), 'remote project file');
  files.set('agent.txt', Buffer.from('agent edit'));
  await writeFile(join(directory, 'README.md'), 'offline local edit');
  await run();
  assert.equal(files.get('README.md')!.toString(), 'offline local edit');
  assert.equal(await readFile(join(directory, 'agent.txt'), 'utf8'), 'agent edit');
  await unlink(join(directory, 'README.md')); await run();
  assert.equal(files.has('README.md'), false);
  await writeFile(join(directory, 'agent.txt'), 'conflicting local edit'); files.set('agent.txt', Buffer.from('conflicting remote edit'));
  await assert.rejects(run(), /Both copies were preserved/);
  assert.equal(await readFile(join(directory, 'agent.txt'), 'utf8'), 'conflicting local edit');
  assert.equal(files.get('agent.txt')!.toString(), 'conflicting remote edit');

  // Run the actual CLI against the same SDK protocol fixture. Auth and session
  // routes are deliberately unsupported: file sync must never start Claude.
  files.set('agent.txt', Buffer.from('conflicting local edit'));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
  const buildDirectory = await mkdtemp(join(projectRoot, '.cantelop', 'file-sync-'));
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-token');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const result = await fetchFixture(new Request(`http://fixture${request.url}`, { method: request.method!, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(500); response.end(); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(buildDirectory, { recursive: true, force: true }); });
  await build({ entryPoints: [join(projectRoot, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })], outfile: join(buildDirectory, 'cli.mjs') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const cli = (watch: boolean) => {
    const child = spawn(process.execPath, [join(buildDirectory, 'cli.mjs'), 'claude', 'sync', '--files', ...(watch ? ['--watch'] : [])], {
      cwd: directory, env: { ...process.env, HOME: root, JUICED_WORKSPACE: project.workspace, CANTELOP_APP_SLUG: 'juiced', CANTELOP_EDGE_URL: `http://127.0.0.1:${address.port}`, CANTELOP_INTEGRATION_TOKEN: 'fixture-token' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume(); child.stdin.end();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const done = once(child, 'close').then(([code]) => { clearTimeout(timeout); return code; });
    t.after(() => { clearTimeout(timeout); child.kill('SIGKILL'); });
    return { child, done, get stderr() { return stderr; } };
  };
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await delay(25); }
    throw new Error('File-sync CLI did not reach the expected state');
  };
  const watching = cli(true);
  await until(() => watching.stderr.includes('Press Ctrl+C'));
  await writeFile(join(directory, 'README.md'), 'watched local edit'); files.set('watched.txt', Buffer.from('watched remote edit'));
  await until(async () => files.get('README.md')?.toString() === 'watched local edit' && await readFile(join(directory, 'watched.txt'), 'utf8').catch(() => '') === 'watched remote edit');
  watching.child.kill('SIGINT'); assert.equal(await watching.done, 130, watching.stderr);
  const onceMore = cli(false); assert.equal(await onceMore.done, 0, onceMore.stderr);
  assert.match(onceMore.stderr, /Files synchronized/);
});
