import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseHandler } from '../src/release-handler';
import { ServiceError } from '../src/config';

const env = { NODE_ENV: 'test' as const, JUICED_RELEASE_TOKEN: 'secret', JUICED_RELEASE_GENERATION: '2' };
const request = (token = 'secret') => new Request('https://juiced.codes/api/release', { method: 'POST', headers: { authorization: `Bearer ${token}` } });

test('promotion requires a deployment-specific secret before loading privileged services', async () => {
  let loaded = 0, promoted = 0, wakes = 0;
  const load = async () => { loaded++; return { pool: {}, accounts: { release: { generation: 2, packageId: 'pkg_new', runtimeId: 'rt_new' } } } as any; };
  const handle = releaseHandler(env, load, async () => { promoted++; return 1; }, async () => { wakes++; });
  assert.equal((await handle(request('wrong'))).status, 401);
  assert.equal(loaded, 0);
  const result = await handle(request());
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { generation: 2, packageId: 'pkg_new', runtimeId: 'rt_new', queued: 1 });
  assert.deepEqual([loaded, promoted, wakes], [1, 1, 1]);
  assert.equal((await releaseHandler({ NODE_ENV: 'test' }, load)(request())).status, 503);
});

test('a failed wake-up is retryable and an obsolete promotion cannot reactivate itself', async () => {
  const load = async () => ({ pool: {}, accounts: { release: { generation: 2 } } }) as any;
  let calls = 0;
  const handle = releaseHandler(env, load, async () => { calls++; return 1; }, async () => { if (calls === 1) throw new Error('queue unavailable'); });
  assert.equal((await handle(request())).status, 503);
  assert.equal((await handle(request())).status, 202);
  const stale = releaseHandler(env, load, async () => { throw new ServiceError('release_superseded', 409); });
  assert.equal((await stale(request())).status, 409);
});
