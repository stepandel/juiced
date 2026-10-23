import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildAppArtifacts } from '@cantelop/sdk/build';

test('the compiled Juice package uses isolated Fleet runtime capabilities and rejects missing ones', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'juiced-fleet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { apps, backend } = await buildAppArtifacts({ definition: resolve('src/cantelop.ts'), outdir: directory });
  const { edge, runtime } = apps[0]!;
  assert.equal(edge.manifest.definition_kind, 'fleet');
  assert.equal(runtime.manifest.definition_kind, 'fleet');
  assert.equal(edge.manifest.cli_build_protocol_version, 7);
  assert.equal(edge.manifest.fleet_execution_protocol_version, 1);
  assert.ok(edge.manifest.optional_bindings.includes('CANTELOP_FLEET_EXECUTION_VERSION'));
  assert.equal(edge.manifest.session_runtime_id, runtime.manifest.session_runtime_id);
  assert.equal(backend.manifest.apps[0]!.session_runtime_id, runtime.manifest.session_runtime_id);
  const { default: worker } = await import(pathToFileURL(edge.mainModule).href);
  const request = (token: string) => new Request('https://juiced.example/commands/workspace.resolve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Cantelop-Session-Runtime': edge.manifest.session_runtime_id },
    body: JSON.stringify({ protocolVersion: 2, id: `msg_${'a'.repeat(32)}`,
      workspace: { slug: 'same-project' }, session: null, command: { type: 'workspace.resolve' } }),
  });
  const bindings = (token: string) => ({ CANTELOP_INTEGRATION_TOKEN: token, CANTELOP_FLEET_EXECUTION_VERSION: '1' });
  await Promise.all(Array.from({ length: 12 }, async (_, account) => {
    const token = `installation-${account}`;
    const workspace = `wsp_${account.toString(16).padStart(32, '0')}`;
    const response = await worker.fetch(request(token), bindings(token), { props: { CANTELOP_RUNTIME: {
      async fetch(target: Request) {
        assert.equal(new URL(target.url).pathname, '/__cantelop/v1/workspaces/open');
        assert.equal(target.headers.get('authorization'), null);
        await new Promise(resolve => setTimeout(resolve, account % 3));
        return Response.json({ id: workspace, slug: 'same-project' });
      },
    } } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, workspace);
    assert.equal((await worker.fetch(request('another-installation'), bindings(token))).status, 401);
  }));
  for (const version of ['1', '2']) {
    const response = await worker.fetch(request('own-token'), { ...bindings('own-token'), CANTELOP_FLEET_EXECUTION_VERSION: version });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'fleet_runtime_unavailable' } });
  }
});
