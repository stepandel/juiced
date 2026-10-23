import { accountFixtureEnv, handleAccountFixture } from './account-fixture.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Exercise the built CLI and real SDK Edge with only local fixture data.
const { createProtocolWorker } = await import(new URL('./protocol-edge.js', import.meta.resolve('@cantelop/sdk')));
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'juiced-delete-local-'));
const id = `wsp_${'a'.repeat(32)}`, appId = `app_${'b'.repeat(32)}`;
let exists = true, fail = false;
const calls = [];
const privateCalls = [];
const worker = createProtocolWorker({ runtimeId: 'fixture.v1', fetch: async request => {
  privateCalls.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
  if (request.method === 'GET') return Response.json({ workspace: exists ? {
    id, app_id: appId, slug: 'chosen', hostname: 'chosen.juiced.cantelop.dev',
    created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z',
  } : null });
  assert.equal(request.method, 'DELETE');
  assert.equal(new URL(request.url).pathname, `/__cantelop/integration/v2/workspaces/${id}`);
  return fail ? Response.json({ error: { code: 'control_unavailable' } }, { status: 503 })
    : Response.json({ id, status: 'deleting', hostArchived: false }, { status: 202 });
} });
const server = createServer(async (request, response) => {
  if (await handleAccountFixture(request, response, 'fixture-token')) return;
  try {
    calls.push(request.url);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await worker.fetch(new Request(origin + request.url, {
      method: request.method, headers: request.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }), { CANTELOP_INTEGRATION_TOKEN: 'fixture-token' });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await mkdir(join(root, 'empty-bin'));
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'project', 'keep.txt'), 'local data');
  const env = { ...process.env, ...await accountFixtureEnv(root, origin), PATH: join(root, 'empty-bin'), CANTELOP_PROFILE: 'deletion-smoke',
    CANTELOP_APP_CONFIG: JSON.stringify({ schemaVersion: 1, activeProfile: 'deletion-smoke', profiles: {
      'deletion-smoke': { defaultApp: { slug: 'juiced' }, apps: [{ id: appId, slug: 'juiced', edgeUrl: origin, accessToken: 'fixture-token' }] },
    } }),
    CANTELOP_APP_SLUG: 'juiced', CANTELOP_EDGE_URL: origin, CANTELOP_INTEGRATION_TOKEN: 'fixture-token',
    CANTELOP_CONFIG: join(root, 'no-account-credentials.json'),
  };
  const run = args => execute(process.execPath, [fileURLToPath(new URL('../bin/juiced.mjs', import.meta.url)), '--workspace', 'chosen', 'claude', 'delete', ...args], { cwd: join(root, 'project'), env });
  await assert.rejects(run([]), error => /Pass --yes/.test(error.stderr));
  assert.equal(calls.length, 0);
  assert.match((await run(['--yes'])).stderr, /Deletion requested for chosen/);
  assert.deepEqual(calls, ['/commands/workspace.inspect', '/commands/workspace.delete']);
  assert.deepEqual(privateCalls, ['GET /__cantelop/integration/v2/workspaces?workspace_slug=chosen', `DELETE /__cantelop/integration/v2/workspaces/${id}`]);
  calls.length = 0;
  exists = false;
  assert.match((await run(['--yes'])).stderr, /does not exist/);
  assert.deepEqual(calls, ['/commands/workspace.inspect']);
  exists = true; fail = true;
  await assert.rejects(run(['--yes']), error => /control_unavailable/.test(error.stderr) && !/Deletion requested/.test(error.stderr));
  assert.equal(await readFile(join(root, 'project', 'keep.txt'), 'utf8'), 'local data');
  console.log('Passed SDK deletion with an empty PATH and fixture account credentials: confirmation, canonical ID, absent workspace, errors, and local file preservation.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
