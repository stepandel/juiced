import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Pool } from 'pg';
import { transaction } from '../src/db';

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
