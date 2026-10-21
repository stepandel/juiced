import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { transaction } from '../src/db';

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
