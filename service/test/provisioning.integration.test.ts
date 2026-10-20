import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, user } from './database.js';
import { Accounts, enqueue, type Account } from '../src/accounts.js';
import { Provisioner } from '../src/provisioning.js';
import type { Platform, PlatformInstallation } from '../src/platform.js';

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
        async installation() {
          return remote!;
        },
        async request(method: string, path: string) {
          if (path.endsWith('/policy')) {
            policies++;
            remote!.policy_revision++;
            return { revision: remote!.policy_revision };
          }
          return {};
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
