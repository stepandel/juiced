import assert from 'node:assert/strict';
import test from 'node:test';
import { FleetError } from '@cantelop/sdk';
import { Platform, type JuicedFleet } from '../src/platform';

const status = { id: `ins_${'a'.repeat(32)}`, externalKey: 'external-account-key', appId: `app_${'a'.repeat(32)}`, packageId: `pkg_${'a'.repeat(32)}`, version: '1.0.0', runtimeId: 'runtime-v1', state: 'ready' as const, policyRevision: 2, enforcedRevision: 1 };
test('Platform delegates lifecycle and trusted App access to SDK instances without exposing credentials', async () => {
  const selectors: unknown[] = [];
  let connections = 0;
  const reference = { async status() { return status; }, async create() { return status; }, async delete() { return {state:'deleting'}; }, async connection() { connections++; return {fetch}; }, async app() { return {name:'juiced'}; } };
  const platform = new Platform({ instance(selector: unknown) { selectors.push(selector); return reference; } } as unknown as JuicedFleet);
  assert.equal((await platform.install(status.externalKey)).app_id, status.appId);
  assert.equal((await platform.find(status.externalKey))!.policy_revision, 2);
  await platform.connection(status.id,{appId:status.appId,runtimeId:status.runtimeId});
  assert.equal(connections,1);
  await assert.rejects(platform.connection(status.id,{appId:`app_${'b'.repeat(32)}`,runtimeId:status.runtimeId}),{code:'installation_changed'});
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
