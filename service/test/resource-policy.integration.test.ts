import assert from 'node:assert/strict';
import test from 'node:test';
import type { FleetPolicyUpdate } from '@cantelop/sdk';
import { Accounts, enqueue } from '../src/accounts';
import { Provisioner } from '../src/provisioning';
import type { Platform } from '../src/platform';
import { promoteRelease } from '../src/release';
import { policyEpoch } from '../src/resource-policy';
import { testDatabase, user } from './database';

const enabled = { skip: !process.env.JUICED_TEST_DATABASE_URL };
const release = { generation: 2, packageId: `pkg_${'a'.repeat(32)}`, runtimeId: 'runtime-1', minimumCli: '0.2.0' };

async function fixture() {
  const f = await testDatabase();
  const accounts = new Accounts(f.pool, release);
  const account = await accounts.ensure(await user(f.pool));
  await accounts.bootstrap(account, { version: '0.3.3', runtimeId: release.runtimeId });
  const installation = (await accounts.installation(account.id))!;
  await f.pool.query(`UPDATE installations SET status='ready',platform_id=$2,app_id=$3,
    entitlement_epoch=$4,policy_revision=4 WHERE id=$1`,
  [installation.id, `ins_${'a'.repeat(32)}`, `app_${'a'.repeat(32)}`, account.period_id]);
  await f.pool.query("UPDATE jobs SET status='done'");
  const projected: FleetPolicyUpdate[] = [];
  const remote = { id: `ins_${'a'.repeat(32)}`, app_id: `app_${'a'.repeat(32)}`, package_id: release.packageId,
    runtime_id: release.runtimeId, status: 'ready', policy_revision: 4, enforced_revision: 4 };
  const platform = { async installation() { return remote; }, async setPolicy(_id: string, update: FleetPolicyUpdate) {
    projected.push(update); remote.policy_revision++; return { revision: remote.policy_revision };
  } } as unknown as Platform;
  return { ...f, accounts, account, installation, remote, projected, worker: new Provisioner(f.pool, accounts, platform) };
}

test('bootstrap replaces legacy caps within the same entitlement and waits for enforcement', enabled, async () => {
  const f = await fixture();
  try {
    const input = { version: '0.3.3', runtimeId: release.runtimeId };
    const repair = await f.accounts.bootstrap(f.account, input);
    assert.equal(repair.status, 'ready', 'queuing a policy repair preserves a usable installation');
    assert.equal(repair.workQueued, true);
    assert.equal(await f.worker.runOnce(), true);
    assert.equal(f.projected.length, 1);
    const { policy, expectedRevision, sourceFence } = f.projected[0]!;
    assert.equal(expectedRevision, 4);
    assert.ok(sourceFence);
    assert.deepEqual(policy, { active: true, expiresAt: f.account.period_end!.toISOString(),
      maxSandboxes: null, maxVcpus: null, maxMemoryMib: null, maxWorkspaces: 8, maxStorageBytes: 10 * 1024 ** 3 });
    assert.equal((await f.accounts.installation(f.account.id))!.status, 'provisioning');
    f.remote.enforced_revision = f.remote.policy_revision;
    await f.pool.query('UPDATE jobs SET available_at=now()');
    await f.worker.runOnce();
    const ready = await f.accounts.bootstrap(f.account, input);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.workQueued, false);
    assert.equal((await f.accounts.installation(f.account.id))!.entitlement_epoch, policyEpoch(f.account.period_id));
    assert.equal(f.projected.length, 1, 'ready bootstrap does not repeatedly project policy');
    // Unlimited compute must not bypass suspension.
    await f.pool.query("UPDATE accounts SET entitlement='inactive' WHERE id=$1", [f.account.id]);
    await enqueue(f.pool, f.account.id, 'suspend', {}, 'suspend-unlimited');
    await f.worker.runOnce();
    assert.deepEqual(f.projected[1]!.policy, { active: false, expiresAt: f.projected[1]!.policy.expiresAt,
      maxSandboxes: 0, maxVcpus: 0, maxMemoryMib: 0, maxWorkspaces: 0, maxStorageBytes: 0 });
  } finally { await f.close(); }
});

test('promotion upgrades ready policies without a package, runtime, or billing-period change', enabled, async () => {
  const f = await fixture();
  try {
    assert.equal(await promoteRelease(f.pool, release), 1);
    assert.equal(await promoteRelease(f.pool, release), 1);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM jobs WHERE status='pending'")).rows[0]!.n, 1);
    await f.worker.runOnce();
    assert.equal(f.projected[0]!.policy.maxSandboxes, null);
    f.remote.enforced_revision = f.remote.policy_revision;
    await f.pool.query('UPDATE jobs SET available_at=now()');
    await f.worker.runOnce();
    assert.equal(await promoteRelease(f.pool, release), 0);
  } finally { await f.close(); }
});
