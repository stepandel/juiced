import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testDatabase, user } from './database';
import { Accounts } from '../src/accounts';

test(
  'deployment roles allow API lifecycle intents but reserve allowance and job projections for the worker',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await testDatabase(),
      { pool } = f,
      tx = await pool.connect();
    try {
      const owner = await user(pool),
        accounts = new Accounts(pool, {
          packageId: 'pkg_roles',
          runtimeId: 'runtime',
          minimumCli: '0.2.0',
        }),
        account = await accounts.ensure(owner);
      const schema = String((await tx.query('SELECT current_schema() AS s')).rows[0]!.s);
      const suffix = crypto.randomUUID().replaceAll('-', ''),
        api = 'api_' + suffix,
        worker = 'worker_' + suffix;
      const grants = (await readFile(new URL('../deploy/roles.sql', import.meta.url), 'utf8'))
        .replaceAll('juiced_api', api)
        .replaceAll('juiced_worker', worker)
        .replaceAll('SCHEMA public', 'SCHEMA ' + schema);
      await tx.query('BEGIN');
      await tx.query(grants);
      await tx.query('SET LOCAL ROLE ' + api);
      await tx.query("UPDATE accounts SET status='suspended' WHERE id=$1", [account.id]);
      await tx.query(
        "INSERT INTO jobs(id,account_id,kind,idempotency_key) VALUES('role-job',$1,'suspend','role-intent')",
        [account.id],
      );
      await tx.query(
        "INSERT INTO audit(account_id,actor,action,target) VALUES($1,'role-test','suspend',$1)",
        [account.id],
      );
      for (const sql of [
        'UPDATE accounts SET included_credits=999',
        'UPDATE jobs SET projection_fence=999',
        "INSERT INTO entitlement_grants(id,account_id,credits,expires_at) VALUES('grant',$1,999,now())",
      ]) {
        await tx.query('SAVEPOINT denied');
        await assert.rejects(
          tx.query(sql, sql.includes('$1') ? [account.id] : []),
          (error) => (error as { code?: string }).code === '42501',
        );
        await tx.query('ROLLBACK TO SAVEPOINT denied');
      }
      await tx.query('SET LOCAL ROLE ' + worker);
      await tx.query('UPDATE accounts SET included_credits=99 WHERE id=$1', [account.id]);
      await tx.query('UPDATE jobs SET projection_fence=999');
      assert.equal(
        String(
          (await tx.query('SELECT included_credits FROM accounts WHERE id=$1', [account.id]))
            .rows[0]!.included_credits,
        ),
        '99',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
      await f.close();
    }
  },
);
