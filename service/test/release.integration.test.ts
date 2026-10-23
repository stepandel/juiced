import assert from 'node:assert/strict';
import test from 'node:test';
import { Accounts, enqueue } from '../src/accounts';
import { currentRelease, promoteRelease } from '../src/release';
import { Provisioner } from '../src/provisioning';
import { reconcile } from '../src/jobs';
import type { Platform } from '../src/platform';
import { testDatabase, user } from './database';
import { policyEpoch } from '../src/resource-policy';

const old = { generation: 1, packageId: 'pkg_old', runtimeId: 'runtime-old', minimumCli: '0.2.0' };
const next = { generation: 2, packageId: 'pkg_new', runtimeId: 'runtime-new', minimumCli: '0.2.0' };
const enabled = { skip: !process.env.JUICED_TEST_DATABASE_URL };

async function fixture() {
  const f = await testDatabase();
  const accounts = new Accounts(f.pool, old);
  const account = await accounts.ensure(await user(f.pool));
  await accounts.bootstrap(account, { version: '0.2.0', runtimeId: old.runtimeId });
  const installation = (await accounts.installation(account.id))!;
  await f.pool.query(`UPDATE installations SET status='ready',platform_id='ins_existing',app_id='app_existing',
    entitlement_epoch=$2,policy_revision=1 WHERE id=$1`, [installation.id, policyEpoch(account.period_id)]);
  return { ...f, accounts, account, installation };
}

test('promotion immediately resets observation backoff, fences stale workers and adopts the ready runtime', enabled, async () => {
  const f = await fixture();
  try {
    await f.pool.query("UPDATE jobs SET attempts=8,available_at=now()+interval '5 minutes'");
    await enqueue(f.pool, f.account.id, 'delete', {}, 'future-delete');
    await f.pool.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE idempotency_key='future-delete'");
    await promoteRelease(f.pool, next);
    const observation = (await f.pool.query("SELECT attempts,available_at<=now() AS due FROM jobs WHERE kind='provision'")).rows;
    assert.ok(observation.length >= 2);
    assert.ok(observation.every(row => row.attempts === 0 && row.due));
    assert.equal((await f.pool.query("SELECT available_at>now()+interval '23 hours' AS untouched FROM jobs WHERE kind='delete'")).rows[0]!.untouched, true);
    const count = (await f.pool.query('SELECT count(*) FROM jobs')).rows[0]!.count;
    await promoteRelease(f.pool, next);
    assert.equal((await f.pool.query('SELECT count(*) FROM jobs')).rows[0]!.count, count);
    assert.equal(await new Provisioner(f.pool, f.accounts, {} as Platform).runOnce(), false);
    let wake = 0;
    await reconcile({ pool: f.pool, accounts: f.accounts, platform: {} as Platform }, async () => { wake++; });
    assert.equal(wake, 0, 'stale deployments drain their queue without scheduling more messages');
    await assert.rejects(f.accounts.bootstrap(f.account, { version: '0.2.0', runtimeId: old.runtimeId }), { code: 'service_unavailable' });
    assert.equal(await currentRelease(f.pool, { generation: 3, packageId: 'pkg_rolling', runtimeId: 'runtime-rolling' }), true,
      'a newer deployment serves while its rollout runs, before promotion');
    const current = new Accounts(f.pool, next);
    const platform = { async installation() { return { id: 'ins_existing', app_id: 'app_existing', package_id: next.packageId,
      runtime_id: next.runtimeId, status: 'ready', policy_revision: 1, enforced_revision: 1 }; } } as unknown as Platform;
    const worker = new Provisioner(f.pool, current, platform);
    while (await worker.runOnce()) { /* drain the two idempotent observations */ }
    const adopted = (await current.installation(f.account.id))!;
    assert.equal(adopted.status, 'ready');
    assert.equal(adopted.runtime_id, next.runtimeId);
    assert.equal(adopted.desired_package_id, null);
    await assert.rejects(promoteRelease(f.pool, old), { code: 'release_superseded' });
    await assert.rejects(promoteRelease(f.pool, { ...next, runtimeId: 'other' }), { code: 'release_superseded' });
    assert.equal((await f.pool.query('SELECT generation FROM juiced_release')).rows[0]!.generation, '2');
  } finally { await f.close(); }
});

test('a worker claimed before promotion cannot project the previous release afterward', enabled, async t => {
  const f = await fixture();
  try {
    const query = f.pool.query.bind(f.pool);
    let promoted = false;
    const mock = t.mock.method(f.pool, 'query', async (...args: Parameters<typeof query>) => {
      const result = await (query as (...args: unknown[]) => Promise<any>)(...args);
      if (!promoted && typeof args[0] === 'string' && args[0].startsWith("UPDATE jobs SET status='running'")) {
        promoted = true;
        await promoteRelease(f.pool, next);
      }
      return result;
    });
    await new Provisioner(f.pool, f.accounts, {} as Platform).runOnce();
    mock.mock.restore();
    assert.equal(promoted, true);
    const installation = (await f.accounts.installation(f.account.id))!;
    assert.equal(installation.desired_package_id, next.packageId);
    assert.equal(installation.package_id, old.packageId);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM jobs WHERE status='running'")).rows[0]!.n, 0);
  } finally { await f.close(); }
});

test('promotion waits for an in-flight projection before setting the next release intent', enabled, async () => {
  const f = await fixture();
  try {
    await promoteRelease(f.pool, old);
    let entered!: () => void, finish!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const platform = { async installation() {
      entered(); await finished;
      return { id: 'ins_existing', app_id: 'app_existing', package_id: old.packageId, runtime_id: old.runtimeId,
        status: 'ready', policy_revision: 1, enforced_revision: 1 };
    } } as unknown as Platform;
    const work = new Provisioner(f.pool, f.accounts, platform).runOnce();
    await running;
    const promotion = promoteRelease(f.pool, next);
    finish();
    await Promise.all([work, promotion]);
    const installation = (await f.accounts.installation(f.account.id))!;
    assert.equal(installation.desired_package_id, next.packageId, 'old projection must finish before the new intent is written');
  } finally { await f.close(); }
});
