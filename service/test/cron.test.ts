import assert from 'node:assert/strict';
import test from 'node:test';
import { cronHandler } from '../src/cron';

test('cron requires its own bearer secret before checking configuration or publishing jobs', async () => {
  const secret = 'private-cron-token';
  let published = 0,
    checked = 0;
  const handle = cronHandler(
    { NODE_ENV: 'test', CRON_SECRET: secret },
    async () => {
      published++;
    },
    async () => {
      checked++;
    },
  );
  const request = (token?: string) =>
    new Request('https://juiced.codes/api/cron', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  assert.equal((await handle(request())).status, 401);
  assert.equal((await handle(request('forged'))).status, 401);
  assert.equal(published, 0);
  assert.equal(checked, 0);
  assert.equal((await handle(request(secret))).status, 202);
  assert.equal(published, 1);
  assert.equal(checked, 1);
});

test('unconfigured or unavailable cron jobs never report successful publication', async () => {
  let published = 0;
  const wake = async () => {
    published++;
  };
  assert.equal(
    (await cronHandler({ NODE_ENV: 'test' }, wake)(new Request('https://juiced.codes/api/cron')))
      .status,
    503,
  );
  const env = { NODE_ENV: 'test' as const, CRON_SECRET: 'secret' };
  const request = () =>
    new Request('https://juiced.codes/api/cron', { headers: { authorization: 'Bearer secret' } });
  const notReady = cronHandler(env, wake, async () => {
    throw new Error('not configured');
  });
  assert.equal((await notReady(request())).status, 503);
  assert.equal(published, 0);
  const unavailable = cronHandler(
    env,
    async () => {
      throw new Error('queue unavailable');
    },
    async () => {},
  );
  assert.equal((await unavailable(request())).status, 503);
});
