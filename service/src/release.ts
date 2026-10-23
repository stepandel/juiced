import type { Pool } from 'pg';
import { transaction, type Queryable } from './db';
import { ServiceError } from './config';

export interface ReleaseIdentity {
  packageId: string;
  runtimeId: string;
  generation?: number;
}

/** The shared lock also prevents promotion in the middle of a projection transaction. */
export async function currentRelease(db: Queryable, release: ReleaseIdentity, lock = false) {
  // Advisory locks also work before the singleton exists, and require no UPDATE
  // privilege for the restricted API role. Call with lock=true inside a transaction.
  if (lock) await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('juiced-release',0))");
  const row = (await db.query(
    'SELECT generation,package_id,runtime_id FROM juiced_release',
  )).rows[0];
  // Additive migration: deployments keep working until the first explicit promotion.
  return !row || (Number(row.generation) === (release.generation ?? 0) &&
    row.package_id === release.packageId && row.runtime_id === release.runtimeId);
}

/** Idempotent promotion wakes every existing account without waiting for client bootstrap. */
export async function promoteRelease(pool: Pool, release: ReleaseIdentity) {
  if (!Number.isSafeInteger(release.generation) || release.generation! <= 0)
    throw new Error('JUICED_RELEASE_GENERATION must be a positive safe integer');
  return transaction(pool, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('juiced-release',0))");
    const previous = (await tx.query('SELECT * FROM juiced_release FOR UPDATE')).rows[0];
    if (previous && (Number(previous.generation) > release.generation! ||
      (Number(previous.generation) === release.generation &&
        (previous.package_id !== release.packageId || previous.runtime_id !== release.runtimeId))))
      throw new ServiceError('release_superseded', 409);
    await tx.query(`INSERT INTO juiced_release(singleton,generation,package_id,runtime_id)
      VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET
      generation=excluded.generation,package_id=excluded.package_id,runtime_id=excluded.runtime_id,
      promoted_at=CASE WHEN juiced_release.generation=excluded.generation
        THEN juiced_release.promoted_at ELSE now() END`,
    [release.generation, release.packageId, release.runtimeId]);
    const installations = (await tx.query(`SELECT i.id,i.account_id FROM installations i
      JOIN accounts a ON a.id=i.account_id WHERE a.status='active' AND a.entitlement='active'
      AND i.status NOT IN ('deleted','deleting')
      AND (i.package_id<>$1 OR i.runtime_id<>$2 OR i.status<>'ready' OR i.desired_package_id IS NOT NULL)
      ORDER BY i.account_id FOR UPDATE OF a,i`, [release.packageId, release.runtimeId])).rows;
    if (installations.length) {
      const ids = installations.map(i => String(i.id));
      const accounts = installations.map(i => String(i.account_id));
      await tx.query(`UPDATE installations SET desired_package_id=$2,desired_runtime_id=$3,
        operation_id='release:'||$4::text||':'||id WHERE id=ANY($1::text[])`,
      [ids, release.packageId, release.runtimeId, release.generation]);
      await tx.query(`INSERT INTO jobs(id,account_id,kind,payload,idempotency_key)
        SELECT 'job_'||md5($2::text||':'||id),account_id,'provision','{}',operation_id
        FROM installations WHERE id=ANY($1::text[]) ON CONFLICT(idempotency_key) DO NOTHING`,
      [ids, release.generation]);
      // Reset pending observation delays only. Never steal a running lease or retry a deletion early.
      await tx.query(`UPDATE jobs SET available_at=now(),attempts=0 WHERE account_id=ANY($1::text[])
        AND kind IN ('provision','upgrade') AND status='pending'`, [accounts]);
    }
    return installations.length;
  });
}
