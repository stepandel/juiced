import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
export function database(raw: string) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('A PostgreSQL database URL is required');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    url.searchParams.set('sslmode', 'verify-full');
  return new Pool({
    connectionString: url.toString(),
    max: 15,
    connectionTimeoutMillis: 5000,
    // Serverless instances freeze or die mid-request. Release idle clients and
    // let Postgres end a transaction left open by a stalled function.
    idleTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 120_000,
  });
}
/** A pool or a transaction client: work that may run inside a caller's transaction. */
export type Queryable = Pick<PoolClient, 'query'>;
export async function transaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}
export async function migrate(pool: Pool) {
  await transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('juiced-migrations',0))");
    await tx.query(
      'CREATE TABLE IF NOT EXISTS juiced_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of [
      '0001-service.sql',
      '0002-auth.sql',
      '0003-billing-lifecycle.sql',
      '0004-upgrades.sql',
      '0005-checkout-cancellation.sql',
      '0006-billing-retries.sql',
      '0007-upgrade-intents.sql',
      '0008-projection-fences.sql',
      '0009-terminal-retries.sql',
      '0010-usage-epoch-index.sql',
    ]) {
      if ((await tx.query('SELECT 1 FROM juiced_migrations WHERE id=$1', [name])).rowCount)
        continue;
      await tx.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      await tx.query('INSERT INTO juiced_migrations(id) VALUES($1)', [name]);
    }
  });
}
