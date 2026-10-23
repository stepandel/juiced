import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Pool } from 'pg';
import { transaction, database } from '../src/db';

for (const queryAfterFailure of [false, true]) {
  test(`transaction handles an idle client error${queryAfterFailure ? ' before another query' : ''}`, async () => {
    const error = new Error('terminating connection due to idle-in-transaction timeout');
    const queries: string[] = [],
      releases: unknown[] = [];
    let failed = false;
    const tx = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        queries.push(sql);
        if (failed) throw new Error('Client has encountered a connection error and is not queryable');
      },
      release(error: unknown) {
        releases.push(error);
      },
    });
    const pool = {
      async connect() {
        return tx;
      },
    } as unknown as Pool;

    await assert.rejects(
      transaction(pool, async (client) => {
        // Model a connection failure delivered while external work is in flight.
        await new Promise<void>((resolve) => setImmediate(() => {
          failed = true;
          tx.emit('error', error);
          resolve();
        }));
        if (queryAfterFailure) await client.query('SELECT 1');
        return 'external work finished';
      }),
      (actual) => actual === error,
    );

    assert.deepEqual(queries, queryAfterFailure ? ['BEGIN', 'SELECT 1'] : ['BEGIN']);
    assert.deepEqual(releases, [error]);
    assert.equal(tx.listenerCount('error'), 0);
  });
}

test('database connections declare their release generation while preserving provider options', async () => {
  const pool = database('postgresql://test@db.example/test?options=endpoint%3Dep-example', 42);
  try {
    const url = new URL(pool.options.connectionString!);
    assert.equal(url.searchParams.get('options'), 'endpoint=ep-example');
    assert.equal(url.searchParams.get('application_name'), 'juiced-release:42');
    assert.equal(url.searchParams.get('sslmode'), 'verify-full');
    for (const generation of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => database('postgresql://localhost/test', generation), /RELEASE_GENERATION/);
  } finally { await pool.end(); }
});

test('the database receives the release identity as a tracked startup parameter',
  { skip: !process.env.JUICED_TEST_DATABASE_URL }, async () => {
    const pool = database(process.env.JUICED_TEST_DATABASE_URL!, 42);
    try {
      assert.equal((await pool.query("SELECT current_setting('application_name') AS name")).rows[0]!.name, 'juiced-release:42');
    } finally { await pool.end(); }
  });
