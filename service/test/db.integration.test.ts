import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate, transaction } from '../src/db';

test(
  'concurrent initialization and repeated migrations preserve account state',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const admin = new Pool({ connectionString: process.env.JUICED_TEST_DATABASE_URL }),
      schema = 'juiced_test_' + crypto.randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.JUICED_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await Promise.all([migrate(pool), migrate(pool)]);
      const account = (
        await pool.query("INSERT INTO accounts(id,owner_user_id) VALUES('acc_test','user_test') RETURNING *")
      ).rows[0];
      assert.equal(account.entitlement, 'active');
      assert.equal(account.period_id, 'free');
      await pool.query("UPDATE accounts SET entitlement='exhausted',included_credits=123 WHERE id='acc_test'");
      const before = (await pool.query('SELECT * FROM accounts')).rows,
        applied = (await pool.query('SELECT * FROM juiced_migrations ORDER BY id')).rows;

      await Promise.all([migrate(pool), migrate(pool)]);

      assert.deepEqual((await pool.query('SELECT * FROM accounts')).rows, before);
      assert.deepEqual(
        (await pool.query('SELECT * FROM juiced_migrations ORDER BY id')).rows,
        applied,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'an idle transaction timeout rejects safely and the pool remains usable',
  { skip: !process.env.JUICED_TEST_DATABASE_URL, timeout: 10000 },
  async () => {
    const pool = new Pool({
      connectionString: process.env.JUICED_TEST_DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    try {
      // A completed transaction returns its value and does not retain a listener.
      assert.equal(await transaction(pool, async () => 'committed'), 'committed');
      const client = await pool.connect();
      assert.equal(client.listenerCount('error'), 0);
      client.release();

      await assert.rejects(
        transaction(pool, async (tx) => {
          // Register for end, not error: the wrapper must handle the fatal event.
          const ended = new Promise<void>((resolve) => tx.once('end', resolve));
          await tx.query("SET LOCAL idle_in_transaction_session_timeout = '100ms'");
          await ended;
          return 'external work finished';
        }),
        { code: '25P03' },
      );

      assert.equal(pool.totalCount, 0);
      assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
      const error = new Error('application failure');
      await assert.rejects(
        transaction(pool, async () => { throw error; }),
        (actual) => actual === error,
      );
      assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
    } finally {
      await pool.end();
    }
  },
);
