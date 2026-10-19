import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { discoverRepository, git } from '../src/git.ts';
import { inspectRemote } from '../src/runtime/inspection.ts';

// Built CLI -> real SDK Edge -> disposable platform fixture -> production
// inspection handler. PATH contains Git only; no Cantelop CLI or account login.
const execute = promisify(execFile);
const { createProtocolWorker } = await import(new URL('./protocol-edge.js', import.meta.resolve('@cantelop/sdk')));
const manifest = JSON.parse(await readFile(new URL('../dist/cantelop/juiced/edge/cantelop-edge.json', import.meta.url), 'utf8'));
const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-inspection-local-')));
const local = join(root, 'project'), workspace = join(root, 'workspace'), remote = join(workspace, 'project');
const id = `wsp_${'a'.repeat(32)}`, appId = `app_${'b'.repeat(32)}`;
const histories = new Map(), emitted = new EventEmitter(), stopped = [], calls = [];
const boundaries = new Map(), sessions = [];
let exists = false, origin;
const lifetime = new AbortController();
const worker = createProtocolWorker({ runtimeId: manifest.session_runtime_id, fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname === '/__cantelop/integration/v2/workspaces') return Response.json({ workspace: exists ? {
    id, app_id: appId, slug: 'chosen', hostname: 'fixture.juiced.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z',
  } : null });
  if (url.pathname === '/__cantelop/integration/v2/requests') {
    const body = await request.json(); assert.equal(body.session.workspace_id, id);
    const command = body.message.payload.message; assert.equal(command.type, 'inspect');
    const session = body.session.id, history = histories.get(session) ?? []; histories.set(session, history); sessions.push(session);
    void inspectRemote(command, { async send(data) {
      history.push({ data, stream_id: 'c'.repeat(32), sequence: history.length + 1, session_id: session, message_id: body.message.id, created_at: new Date().toISOString() }); emitted.emit(session);
    } }, lifetime.signal, workspace).then(() => boundaries.set(session, history.length)).catch(error => emitted.emit('error', error));
    return Response.json({ id: body.message.id, reply: { ok: true } });
  }
  const match = /^\/__cantelop\/integration\/v2\/sessions\/([^/]+)(\/events|\/view)?$/.exec(url.pathname);
  assert.ok(match, `Unexpected platform route: ${url.pathname}`); assert.equal(url.searchParams.get('workspace_id'), id);
  const session = match[1];
  if (match[2] === '/view') {
    const sequence = boundaries.get(session);
    return sequence === undefined ? Response.json({ error: { code: 'session_view_not_found' } }, { status: 404 }) : Response.json({ workspaceId: id, sessionId: session, revision: '1', updatedAt: new Date().toISOString(), state: { inspection: 1 }, cursor: { streamId: 'c'.repeat(32), sequence } });
  }
  if (request.method === 'DELETE') { stopped.push(session); return new Response(null, { status: 204 }); }
  assert.equal(match[2], '/events'); let index = Number(url.searchParams.get('after') ?? 0);
  return new Response(new ReadableStream({ async pull(controller) {
    try {
      while (!histories.get(session)?.[index]) await once(emitted, session, { signal: request.signal });
      const event = histories.get(session)[index++];
      controller.enqueue(new TextEncoder().encode(`id: ${event.stream_id}:${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`));
    } catch (error) { controller.error(error); }
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
} });
const server = createServer(async (request, response) => {
  const controller = new AbortController(); response.once('close', () => controller.abort());
  try {
    calls.push(request.url); const bytes = []; for await (const chunk of request) bytes.push(chunk);
    const result = await worker.fetch(new Request(origin + request.url, { method: request.method, headers: request.headers,
      signal: controller.signal, ...(bytes.length ? { body: Buffer.concat(bytes) } : {}),
    }), { CANTELOP_INTEGRATION_TOKEN: 'fixture-token', CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS: '120' });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
    response.end();
  } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
});
try {
  await mkdir(local); await mkdir(workspace); await git(local, ['init', '-b', 'main']);
  await git(local, ['config', 'user.name', 'Inspection Fixture']); await git(local, ['config', 'user.email', 'test@example.test']);
  await mkdir(join(local, 'src')); await writeFile(join(local, 'src', 'entry.ts'), 'base\n');
  await writeFile(join(local, 'README.md'), 'matching\n'); await writeFile(join(local, '.gitignore'), '.env\n');
  await git(local, ['add', '.']); await git(local, ['commit', '-m', 'fixture']); await git(root, ['clone', '--no-hardlinks', local, remote]);
  await writeFile(join(remote, 'src', 'entry.ts'), 'remote dirty\n'); await writeFile(join(remote, 'src', 'new.bin'), Buffer.from([0, 1, 255]));
  await writeFile(join(local, 'local-only.txt'), 'local\n'); await writeFile(join(remote, 'remote-only.txt'), 'remote\n');
  await writeFile(join(local, '.env'), 'local ignored\n'); await writeFile(join(remote, '.env'), 'remote ignored\n');
  const repository = await discoverRepository(local);
  await mkdir(join(workspace, '.juiced', 'project'), { recursive: true });
  await writeFile(join(workspace, '.juiced', 'project', 'binding.json'), JSON.stringify({ version: 1, binding: repository.binding, sourceBranch: 'main' }));
  await mkdir(join(root, 'bin')); await symlink((await execute('which', ['git'])).stdout.trim(), join(root, 'bin', 'git'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, PATH: join(root, 'bin'), CANTELOP_PROFILE: 'inspection-smoke',
    CANTELOP_APP_CONFIG: JSON.stringify({ schemaVersion: 1, activeProfile: 'inspection-smoke', profiles: { 'inspection-smoke': {
      defaultApp: { slug: 'juiced' }, apps: [{ id: appId, slug: 'juiced', edgeUrl: origin, accessToken: 'fixture-token' }],
    } } }), CANTELOP_APP_SLUG: 'juiced', CANTELOP_EDGE_URL: origin, CANTELOP_INTEGRATION_TOKEN: 'fixture-token', CANTELOP_CONFIG: join(root, 'no-account-credentials.json'),
  };
  const run = (...args) => execute(process.execPath, [fileURLToPath(new URL('../bin/juiced.mjs', import.meta.url)), '--workspace', 'chosen', 'claude', ...args], { cwd: local, env, timeout: 20_000 });
  await assert.rejects(run('peek'), error => error.code === 2 && /does not exist/.test(error.stdout));
  assert.deepEqual(calls, ['/commands/workspace.inspect']); exists = true; calls.length = 0;
  const peek = (await run('peek')).stdout;
  assert.match(peek, /src\/\s+!\s+src\//); assert.match(peek, /README\.md\s+=\s+README\.md/);
  const changes = (await run('peek', '--changes-only')).stdout;
  assert.match(changes, /src\/\s+!\s+src\//); assert.doesNotMatch(changes, /README\.md\s+=/);
  const listing = (await run('ls')).stdout;
  assert.match(listing, /^README\.md$/m); assert.match(listing, /^remote-only\.txt$/m);
  assert.doesNotMatch(listing, /Local:|Local HEAD:|matching|different|local-only|new.bin/);
  const listedChildren = (await run('ls', 'src/')).stdout;
  assert.match(listedChildren, /^new\.bin$/m); assert.doesNotMatch(listedChildren, /README|Local:|matching/);
  const listedFile = (await run('ls', '--include-ignored', '.env')).stdout;
  assert.match(listedFile, /^\.env$/m); assert.doesNotMatch(listedFile, /remote ignored|local ignored/);
  await assert.rejects(run('ls', 'missing'), error => error.code === 2 && /Path absent in the remote workspace/.test(error.stdout));
  const nested = (await run('peek', 'src/')).stdout; assert.match(nested, /new.bin/); assert.match(nested, /entry.ts/);
  await assert.rejects(run('peek', '.env'), error => error.code === 2 && /\[ignored\]/.test(error.stdout));
  assert.match((await run('peek', '--include-ignored', '.env')).stdout, /\.env\s+!\s+\.env/);
  const journal = join(workspace, '.juiced', 'project', 'journal.json'); await writeFile(journal, 'pending');
  await assert.rejects(run('peek'), error => error.code === 2 && /pending recovery/.test(error.stderr));
  assert.equal(await readFile(journal, 'utf8'), 'pending'); assert.equal(await readFile(join(local, '.env'), 'utf8'), 'local ignored\n');
  assert.ok(calls.every(path => ['/commands/workspace.inspect', '/commands/view', '/commands/request', '/commands/stream'].includes(path)));
  assert.equal(stopped.length, 0); assert.equal(sessions.length, 10); assert.equal(new Set(sessions).size, 1);
  console.log('Passed built CLI and SDK Edge inspection: remote-only ls, complete peek, changes-only filter, drill-down, ignored files, missing paths/workspace, preserved journal, canonical IDs, and Git-only PATH.');
} finally {
  lifetime.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
