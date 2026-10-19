import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CantelopClient } from '@cantelop/sdk';
import { selectProject, synchronizeProject } from '../src/project.js';

// Only the remote transport is a fixture. All local I/O uses the SDK's shipped
// native adapter, with no Cantelop executable, account profile, or Go on PATH.
test('project sync uploads, downloads and reconnects using only the SDK', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-sdk-sync-'));
  const env = { PATH: process.env.PATH, CANTELOP_SYNC_HELPER: process.env.CANTELOP_SYNC_HELPER, CANTELOP_SYNC_STATE_HOME: process.env.CANTELOP_SYNC_STATE_HOME };
  const controller = new AbortController();
  let sync: Awaited<ReturnType<typeof synchronizeProject>> | undefined;
  try {
    process.env.PATH = '';
    process.env.CANTELOP_SYNC_HELPER = '/missing/cantelop';
    process.env.CANTELOP_SYNC_STATE_HOME = join(root, 'state');
    const directory = join(root, 'My Project');await mkdir(directory);
    const project = await selectProject(directory);
    const id = `wsp_${'a'.repeat(32)}`;
    const hash = (data: Buffer) => createHash('sha256').update(Buffer.from([0])).update(data).digest('hex');
    const entry = (path: string, data: Buffer) => ({ path, version: hash(data), size: data.length, executable: false });
    const files = new Map([['remote.txt', Buffer.from('remote project file')]]);
    const app = new CantelopClient().app({ name: 'sync-test', runtime: { receive() {} }, connection: { async fetch(request) {
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
      if (op === 'write') { const data = Buffer.from(await request.arrayBuffer());files.set(name, data);return Response.json(entry(name, data)); }
      if (op === 'remove') { files.delete(name);return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected sync operation: ${op}`);
    } } });
    const workspace = app.workspace({ slug: project.workspace });
    await writeFile(join(directory, 'README.md'), 'local project');
    await writeFile(join(directory, '.env'), 'excluded secret');
    await mkdir(join(directory, 'dist'));await writeFile(join(directory, 'dist', 'output.js'), 'excluded build');
    sync = await synchronizeProject(workspace, project, controller.signal);
    assert.equal(sync.status().state, 'synced');
    assert.equal(files.get('README.md')!.toString(), 'local project');
    assert.equal(files.has('.env'), false);assert.equal(files.has('dist/output.js'), false);
    assert.equal(await readFile(join(directory, 'remote.txt'), 'utf8'), 'remote project file');
    files.set('agent.txt', Buffer.from('agent edit'));await sync.flush();
    assert.equal(await readFile(join(directory, 'agent.txt'), 'utf8'), 'agent edit');
    await sync.close();sync = undefined;
    await writeFile(join(directory, 'README.md'), 'offline local edit');
    sync = await synchronizeProject(workspace, project, controller.signal);
    assert.equal(files.get('README.md')!.toString(), 'offline local edit');
    await unlink(join(directory, 'README.md'));await sync.flush();
    assert.equal(files.has('README.md'), false);
  } finally {
    try { await sync?.close(); } finally {
      controller.abort();
      for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key];else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  }
});
