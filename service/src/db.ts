import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { ServiceError } from './config';
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
/** Counts one request in the key's current one-minute window. */
export async function rateLimit(db: Queryable, key: string, max: number) {
  const count = (
    await db.query(
      `INSERT INTO api_limits(key,bucket,count) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN api_limits.bucket=excluded.bucket THEN api_limits.count+1 ELSE 1 END RETURNING count`,
      [key, Math.floor(Date.now() / 60000)],
    )
  ).rows[0]!.count;
  if (count > max) throw new ServiceError('rate_limit_exceeded', 429);
}
export async function transaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  let clientError: Error | undefined;
  // A timeout or disconnect between queries emits an error on the client.
  const onError = (error: Error) => {
    clientError ??= error;
  };
  tx.on('error', onError);
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    if (clientError) throw clientError;
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    if (!clientError) await tx.query('ROLLBACK').catch(() => {});
    throw clientError ?? error;
  } finally {
    tx.release(clientError);
    tx.removeListener('error', onError);
  }
}
export async function migrate(pool: Pool) {
  await transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('juiced-migrations',0))");
    await tx.query(
      'CREATE TABLE IF NOT EXISTS juiced_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of ['0001-initial.sql']) {
      if ((await tx.query('SELECT 1 FROM juiced_migrations WHERE id=$1', [name])).rowCount)
        continue;
      await tx.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      await tx.query('INSERT INTO juiced_migrations(id) VALUES($1)', [name]);
    }
  });
}
