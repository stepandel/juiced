import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, user } from './database';
import { Accounts, enqueue, type Account } from '../src/accounts';
import { Provisioner } from '../src/provisioning';
import type { Platform, PlatformInstallation } from '../src/platform';
import { ServiceError } from '../src/config';

test(
  'durable provisioning recovers an ambiguous create and renews policy once per epoch',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await testDatabase(),
      { pool } = f;
    try {
      const accounts = new Accounts(pool, {
          packageId: 'pkg_' + 'a'.repeat(32),
          runtimeId: 'runtime-1',
          minimumCli: '0.2.0',
        }),
        a = await accounts.ensure(await user(pool));
      await pool.query(
        `UPDATE accounts SET entitlement='active',period_id='invoice-1',period_end=now()+interval '1 day',included_credits=10000000 WHERE id=$1`,
        [a.id],
      );
      const active = (await pool.query<Account>('SELECT * FROM accounts WHERE id=$1', [a.id]))
        .rows[0]!;
      await accounts.bootstrap(active, { version: '0.2.0', runtimeId: 'runtime-1' });
      let remote: PlatformInstallation | undefined,
        ambiguous = true,
        creates = 0,
        policies = 0;
      const platform = {
        async install() {
          remote ??= {
            id: 'ins_' + 'a'.repeat(32),
            app_id: 'app_' + 'a'.repeat(32),
            package_id: accounts.release.packageId,
            runtime_id: 'runtime-1',
            status: 'provisioning',
            policy_revision: 1,
            enforced_revision: 0,
          };
          if (ambiguous) {
            creates++;
            ambiguous = false;
            throw new Error('lost response');
          }
          return remote;
        },
        async find() { return remote; },
        async installation() {
          return remote!;
        },
        async setPolicy() {
          policies++;
          remote!.policy_revision++;
          return { revision: remote!.policy_revision };
        },
      } as unknown as Platform;
      const p = new Provisioner(pool, accounts, platform);
      assert.equal(await p.runOnce(), true);
      assert.equal((await accounts.installation(a.id))!.platform_id, null);
      await pool.query('UPDATE jobs SET available_at=now()');
      await Promise.all([p.runOnce(), p.runOnce()]);
      assert.equal(creates, 1);
      assert.equal(policies, 1);
      remote!.status = 'ready';
      remote!.enforced_revision = remote!.policy_revision;
      await pool.query('UPDATE jobs SET available_at=now()');
      await p.runOnce();
      assert.equal((await accounts.installation(a.id))!.status, 'ready');
      assert.equal(policies, 1);
      await pool.query(
        "UPDATE accounts SET period_id='invoice-2',period_end=now()+interval '2 days' WHERE id=$1",
        [a.id],
      );
      await enqueue(pool, a.id, 'provision', {}, 'renew-test');
      await p.runOnce();
      assert.equal(policies, 2);
      assert.equal((await accounts.installation(a.id))!.entitlement_epoch, 'invoice-2');
      // A stale bootstrap snapshot cannot provision after suspension won the lock.
      const b = await accounts.ensure(await user(pool));
      await pool.query(
        "UPDATE accounts SET entitlement='active',period_end=now()+interval '1 day' WHERE id=$1",
        [b.id],
      );
      const snapshot = (await pool.query<Account>('SELECT * FROM accounts WHERE id=$1', [b.id]))
        .rows[0]!;
      await pool.query("UPDATE accounts SET entitlement='inactive' WHERE id=$1", [b.id]);
      await assert.rejects(
        accounts.bootstrap(snapshot, { version: '0.2.0', runtimeId: 'runtime-1' }),
        { code: 'subscription_required' },
      );
      assert.equal(await accounts.installation(b.id), undefined);
    } finally {
      await f.close();
    }
  },
);
test(
  'deletion without an installation still cancels billing and removes identity',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await testDatabase();
    try {
      const accounts = new Accounts(f.pool, {
          packageId: 'pkg_' + 'a'.repeat(32),
          runtimeId: 'runtime-1',
          minimumCli: '0.2.0',
        }),
        a = await accounts.ensure(await user(f.pool));
      await f.pool.query("UPDATE accounts SET status='deleting' WHERE id=$1", [a.id]);
      await enqueue(f.pool, a.id, 'delete', {}, 'delete-test');
      let canceled = 0;
      const p = new Provisioner(f.pool, accounts, {} as Platform, {
        async cancel() {
          canceled++;
        },
      });
      await p.runOnce();
      assert.equal(canceled, 1);
      assert.equal(
        (await f.pool.query('SELECT status FROM accounts WHERE id=$1', [a.id])).rows[0].status,
        'deleted',
      );
      assert.equal(
        (await f.pool.query('SELECT 1 FROM "user" WHERE id=$1', [a.owner_user_id])).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  'deletion converges when the platform installation is already gone',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await testDatabase();
    try {
      const accounts = new Accounts(f.pool, {
          packageId: 'pkg_' + 'a'.repeat(32),
          runtimeId: 'runtime-1',
          minimumCli: '0.2.0',
        }),
        a = await accounts.ensure(await user(f.pool));
      await f.pool.query(
        `INSERT INTO installations(id,account_id,external_key,platform_id,app_id,package_id,runtime_id,status)
        VALUES('jin_gone',$1,'installation_gone',$2,$3,$4,'runtime-1','deleting')`,
        [a.id, 'ins_' + 'b'.repeat(32), 'app_' + 'b'.repeat(32), accounts.release.packageId],
      );
      await f.pool.query("UPDATE accounts SET status='deleting' WHERE id=$1", [a.id]);
      await enqueue(f.pool, a.id, 'delete', {}, 'delete-gone');
      // An earlier pass deleted the remote installation; every call now answers 404.
      const missing = async () => {
        throw new ServiceError('platform_not_found', 404);
      };
      const platform = {
        remove: missing,
        removeById: missing,
        installation: missing,
      } as unknown as Platform;
      await new Provisioner(f.pool, accounts, platform, { async cancel() {} }).runOnce();
      assert.equal(
        (await f.pool.query('SELECT status FROM accounts WHERE id=$1', [a.id])).rows[0].status,
        'deleted',
      );
      assert.equal(
        (await f.pool.query("SELECT status FROM jobs WHERE idempotency_key='delete-gone'")).rows[0]
          .status,
        'done',
      );
    } finally {
      await f.close();
    }
  },
);

test('provisioning observes CLI rollout and never changes an existing instance package', { skip: !process.env.JUICED_TEST_DATABASE_URL }, async () => {
  const f = await testDatabase();
  try {
    const packageId = `pkg_${'b'.repeat(32)}`;
    const accounts = new Accounts(f.pool, { packageId, runtimeId: 'runtime-new', minimumCli: '0.2.0' });
    const account = await accounts.ensure(await user(f.pool));
    await f.pool.query("UPDATE accounts SET entitlement='active',period_id='invoice',period_end=now()+interval '1 day' WHERE id=$1", [account.id]);
    await f.pool.query(`INSERT INTO installations(id,account_id,external_key,platform_id,app_id,package_id,runtime_id,status,entitlement_epoch,policy_revision)
      VALUES('jin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$1,'external-existing-account',$2,$3,$4,'runtime-old','ready','invoice',1)`, [account.id, `ins_${'a'.repeat(32)}`, `app_${'a'.repeat(32)}`, `pkg_${'a'.repeat(32)}`]);
    const active = (await f.pool.query<Account>('SELECT * FROM accounts WHERE id=$1', [account.id])).rows[0]!;
    await accounts.bootstrap(active, { version: '0.2.0', runtimeId: 'runtime-new' });
    let remote: PlatformInstallation = {id:`ins_${'a'.repeat(32)}`,app_id:`app_${'a'.repeat(32)}`,package_id:`pkg_${'a'.repeat(32)}`,runtime_id:'runtime-old',status:'ready',policy_revision:1,enforced_revision:1};
    const platform = { async installation() { return remote; } } as unknown as Platform;
    const worker = new Provisioner(f.pool, accounts, platform);
    await worker.runOnce();
    assert.equal((await accounts.installation(account.id))!.package_id, `pkg_${'a'.repeat(32)}`);
    assert.equal((await f.pool.query('SELECT status FROM jobs')).rows[0]!.status, 'pending');
    // The CLI/platform finishes rollout outside the Juiced service.
    remote = {...remote,package_id:packageId,runtime_id:'runtime-new'};
    await f.pool.query('UPDATE jobs SET available_at=now()');
    await worker.runOnce();
    const current = (await accounts.installation(account.id))!;
    assert.equal(current.status, 'ready');
    assert.equal(current.runtime_id, 'runtime-new');
    assert.equal(current.package_id, packageId);
    assert.equal(current.desired_package_id, null);
  } finally { await f.close(); }
});

test('a stale service release keeps ready installations usable and failed instances back off', { skip: !process.env.JUICED_TEST_DATABASE_URL }, async t => {
  const f = await testDatabase();
  try {
    const packageId = `pkg_${'a'.repeat(32)}`;
    const accounts = new Accounts(f.pool, { packageId, runtimeId: 'runtime-old', minimumCli: '0.2.0' });
    const account = await accounts.ensure(await user(f.pool));
    await f.pool.query("UPDATE accounts SET entitlement='active',period_id='invoice',period_end=now()+interval '1 day' WHERE id=$1", [account.id]);
    await f.pool.query(`INSERT INTO installations(id,account_id,external_key,platform_id,app_id,package_id,runtime_id,status,entitlement_epoch,policy_revision)
      VALUES('jin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$1,'external-existing-account',$2,$3,$4,'runtime-old','ready','invoice',1)`, [account.id, `ins_${'a'.repeat(32)}`, `app_${'a'.repeat(32)}`, packageId]);
    await enqueue(f.pool, account.id, 'provision', {}, 'renewal');
    // The CLI already rolled the Fleet forward; this service still names the old release.
    let remote: PlatformInstallation = { id: `ins_${'a'.repeat(32)}`, app_id: `app_${'a'.repeat(32)}`, package_id: `pkg_${'b'.repeat(32)}`, runtime_id: 'runtime-new', status: 'ready', policy_revision: 1, enforced_revision: 1 };
    const worker = new Provisioner(f.pool, accounts, { async installation() { return remote; } } as unknown as Platform);
    const errors = t.mock.method(console, 'error', () => {});
    await worker.runOnce();
    const job = async () => (await f.pool.query("SELECT status,extract(epoch FROM available_at-now()) AS delay FROM jobs WHERE idempotency_key='renewal'")).rows[0]!;
    assert.equal((await accounts.installation(account.id))!.status, 'ready');
    assert.equal(JSON.parse(errors.mock.calls[0]!.arguments[0] as string).error, 'release_mismatch');
    assert.equal((await job()).status, 'pending');
    remote = { ...remote, package_id: packageId, runtime_id: 'runtime-old', status: 'failed' };
    await f.pool.query("UPDATE jobs SET available_at=now(),attempts=4 WHERE idempotency_key='renewal'");
    await worker.runOnce();
    assert.equal((await accounts.installation(account.id))!.status, 'failed');
    const failed = await job();
    assert.equal(failed.status, 'pending');
    assert.ok(Number(failed.delay) > 60, 'repeated waits back off instead of retrying every 5 seconds');
  } finally { await f.close(); }
});
