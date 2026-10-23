import assert from 'node:assert/strict';
import test from 'node:test';
import { FleetError } from '@cantelop/sdk';
import { Platform, type JuicedFleet } from '../src/platform';
import type { AppConnection } from '@cantelop/sdk';

const status = { id: `ins_${'a'.repeat(32)}`, externalKey: 'external-account-key', appId: `app_${'a'.repeat(32)}`, packageId: `pkg_${'a'.repeat(32)}`, version: '1.0.0', runtimeId: 'runtime-v1', state: 'ready' as const, policyRevision: 2, enforcedRevision: 1 };
test('Platform delegates lifecycle and trusted App access to SDK instances without exposing credentials', async () => {
  const selectors: unknown[] = [];
  let connections = 0;
  const reference = { async status() { return status; }, async create() { return status; }, async delete() { return {state:'deleting'}; }, async connection() { connections++; return {fetch}; }, async app() { return {name:'juiced'}; } };
  const platform = new Platform({ runtimeId: status.runtimeId, instance(selector: unknown) { selectors.push(selector); return reference; } } as unknown as JuicedFleet);
  assert.equal((await platform.install(status.externalKey)).app_id, status.appId);
  assert.equal((await platform.find(status.externalKey))!.policy_revision, 2);
  await platform.connection(status.id,{appId:status.appId,runtimeId:status.runtimeId});
  assert.equal(connections,1);
  await assert.rejects(platform.connection(status.id,{appId:status.appId,runtimeId:'runtime-v0'}),{code:'installation_changed'});
  await assert.rejects(platform.connection(status.id,{appId:null,runtimeId:status.runtimeId}),{code:'installation_changed'});
  assert.equal(connections,1);
  await platform.remove(status.externalKey);
  assert.deepEqual(selectors.at(-1),{externalKey:status.externalKey});
});
test('SDK status absence and platform failures retain Juiced public error semantics', async () => {
  let failure: Error | undefined;
  const platform = new Platform({instance(){return {async status(){if(failure)throw failure;return undefined;}};}} as unknown as JuicedFleet);
  assert.equal(await platform.find(status.externalKey),undefined);
  await assert.rejects(platform.installation(status.id),{code:'platform_not_found',status:404});
  failure = new FleetError('session_runtime_mismatch',409);
  await assert.rejects(platform.installation(status.id),{code:'installation_changed',status:409});
  failure = new FleetError('forbidden',403);
  await assert.rejects(platform.installation(status.id),{code:'platform_unavailable',status:503});
});

const pin = { appId: status.appId, runtimeId: status.runtimeId };
function connectionFixture(load: () => Promise<AppConnection>, now = () => 0) {
  return new Platform({ runtimeId: status.runtimeId, instance() { return { connection: load }; } } as unknown as JuicedFleet, now);
}

test('relay connections coalesce concurrent setup and expire 30 seconds after setup completes', async () => {
  let calls = 0, now = 0;
  let finish!: (connection: AppConnection) => void;
  const platform = connectionFixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => now);
  const first = platform.connection(status.id, pin), concurrent = platform.connection(status.id, pin);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  now = 20_000;
  finish({ fetch: async () => new Response() });
  const connection = await first;
  assert.equal(await concurrent, connection);
  now = 49_999;
  assert.equal(await platform.connection(status.id, pin), connection);
  now = 50_000;
  const refreshed = platform.connection(status.id, pin);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish({ fetch: async () => new Response() });
  assert.notEqual(await refreshed, connection);
});

test('connection reuse stays scoped to the installation and App and still checks runtime pins', async () => {
  let calls = 0;
  const platform = connectionFixture(async () => { calls++; return { fetch: async () => new Response() }; });
  const connection = await platform.connection(status.id, pin);
  assert.equal(await platform.connection(status.id, pin), connection);
  assert.notEqual(await platform.connection(`ins_${'b'.repeat(32)}`, pin), connection);
  assert.notEqual(await platform.connection(status.id, { ...pin, appId: `app_${'b'.repeat(32)}` }), connection);
  await assert.rejects(platform.connection(status.id, { ...pin, runtimeId: 'old' }), { code: 'installation_changed' });
  await assert.rejects(platform.connection(status.id, { ...pin, appId: null }), { code: 'installation_changed' });
  assert.equal(calls, 3);
});

test('failed connection setup retries and retains public error translation', async () => {
  let calls = 0;
  const platform = connectionFixture(async () => {
    if (++calls === 1) throw new FleetError('forbidden', 403);
    return { fetch: async () => new Response() };
  });
  await assert.rejects(platform.connection(status.id, pin), { code: 'platform_unavailable', status: 503 });
  await platform.connection(status.id, pin);
  assert.equal(calls, 2);
});

test('authorization and runtime rejection invalidate connections without replaying the request', async () => {
  for (const statusCode of [401, 403, 409]) {
    let calls = 0, sent = 0;
    const request = new Request('https://edge.example/command', { method: 'POST', body: 'opaque command' });
    const response = new Response('rejected', { status: statusCode });
    const platform = connectionFixture(async () => {
      calls++;
      return { fetch: async input => { sent++; assert.equal(input, request); return response; } };
    });
    const connection = await platform.connection(status.id, pin);
    assert.equal(await connection.fetch(request), response);
    assert.equal(sent, 1);
    assert.notEqual(await platform.connection(status.id, pin), connection);
    assert.equal(calls, 2);
  }
});

test('a late rejected response cannot evict a newer connection', async () => {
  let now = 0, calls = 0;
  let finish!: (response: Response) => void;
  const platform = connectionFixture(async () => {
    calls++;
    return { fetch: () => new Promise(resolve => { finish = resolve; }) };
  }, () => now);
  const old = await platform.connection(status.id, pin);
  const request = old.fetch(new Request('https://edge.example/command'));
  now = 30_000;
  const current = await platform.connection(status.id, pin);
  finish(new Response(null, { status: 401 }));
  await request;
  assert.equal(await platform.connection(status.id, pin), current);
  assert.equal(calls, 2);
});

test('connection cache bounds retained installations and evicts the least recently used', async () => {
  let calls = 0;
  const platform = connectionFixture(async () => { calls++; return { fetch: async () => new Response() }; });
  const id = (i: number) => `ins_${i.toString(16).padStart(32, '0')}`;
  const first = await platform.connection(id(0), pin);
  for (let i = 1; i < 256; i++) await platform.connection(id(i), pin);
  assert.equal(await platform.connection(id(0), pin), first);
  await platform.connection(id(256), pin);
  assert.equal(await platform.connection(id(0), pin), first);
  assert.equal(calls, 257);
  await platform.connection(id(1), pin);
  assert.equal(calls, 258);
});
