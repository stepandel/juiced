// Invoked by the platform Go integration test against real confined file storage.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProject, synchronizeProject } from '../../src/project.js';
import { createTerminal } from '../../src/runtime/terminal.js';

const [origin, local, remoteWorkspace, sdkDirectory] = process.argv.slice(2) as [string, string, string, string];
const { CantelopClient } = await import(pathToFileURL(join(sdkDirectory, 'dist/index.js')).href);
const { createProtocolWorker } = await import(pathToFileURL(join(sdkDirectory, 'dist/protocol-edge.js')).href);
const workspaceID = 'wsp_11111111111111111111111111111111';
const worker = createProtocolWorker({ runtimeId: 'fixture.v1', fetch: async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/workspaces/' + workspaceID)) return Response.json({ id: workspaceID, app_id: 'app_' + '2'.repeat(32), slug: 'fixture', hostname: 'fixture.example', created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z' });
  assert.equal(url.pathname, `/__cantelop/integration/v2/workspaces/${workspaceID}/sync`);
  return fetch(new URL('/' + url.search, origin), { method: request.method, signal: request.signal, ...(request.body ? { body: await request.arrayBuffer() } : {}) });
} });
const app = new CantelopClient().app({ name: 'fixture', runtime: { receive() {} }, connection: { fetch(request: Request) {
  const headers = new Headers(request.headers); headers.set('Authorization', 'Bearer fixture-token');
  return worker.fetch(new Request(request, { headers }), { CANTELOP_INTEGRATION_TOKEN: 'fixture-token' });
} } });
await mkdir(join(remoteWorkspace, '.claude'), { recursive: true });
await mkdir(join(remoteWorkspace, '.local'), { recursive: true });
await writeFile(join(remoteWorkspace, '.claude', 'account-fixture'), 'keep account state');
await writeFile(join(remoteWorkspace, '.local', 'sibling-fixture'), 'keep local state');
await writeFile(join(remoteWorkspace, 'sibling.txt'), 'keep unrelated content');
await mkdir(local, { recursive: true });
await writeFile(join(local, 'README.md'), 'the local project'); await writeFile(join(local, '.env'), 'do not upload');
const project = await selectProject(local);
const lifetime = new AbortController();
const sync = await synchronizeProject(app.workspace({ id: workspaceID }), project, lifetime.signal);
try {
  const remote = join(remoteWorkspace, project.directoryName);
  assert.equal(await readFile(join(remote, 'README.md'), 'utf8'), 'the local project');
  for (const [name, expected] of [['.claude/account-fixture', 'keep account state'], ['.local/sibling-fixture', 'keep local state'], ['sibling.txt', 'keep unrelated content']]) {
    assert.equal(await readFile(join(remoteWorkspace, name!), 'utf8'), expected);
    await assert.rejects(readFile(join(local, name!)), { code: 'ENOENT' });
  }
  await assert.rejects(readFile(join(remote, '.env')), { code: 'ENOENT' });
  let stdout = '';
  const terminal = createTerminal({ signal: lifetime.signal, session: { id: 'fixture', keepAliveSeconds: 120 }, env: {}, database: async () => { throw Error('unused'); } }, { workspace: remoteWorkspace, binary: process.execPath });
  await terminal.run({ type: 'start', directoryName: project.directoryName, tty: false, columns: 80, rows: 24, term: 'dumb', argv: ['-e', `const fs=require('node:fs'); console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,readme:fs.readFileSync('README.md','utf8')})); fs.writeFileSync('agent.txt','remote edit');`] }, { signal: lifetime.signal, output: { async send(event) { if (event.type === 'output' && event.channel === 'stdout') stdout += Buffer.from(event.data, 'base64').toString(); } } });
  const result = JSON.parse(stdout.trim()); assert.equal(result.cwd, await realpath(remote)); assert.equal(result.home, remoteWorkspace); assert.equal(result.readme, 'the local project');
  await sync.flush(); assert.equal(await readFile(join(local, 'agent.txt'), 'utf8'), 'remote edit');
  await writeFile(join(local, 'README.md'), 'local edit'); await sync.flush(); assert.equal(await readFile(join(remote, 'README.md'), 'utf8'), 'local edit');
  console.log('Juiced directory selection, initial upload, remote cwd, preserved HOME, exclusions, and both sync directions passed.');
} finally { await sync.close(); lifetime.abort(); }
