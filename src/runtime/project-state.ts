import { randomUUID } from 'node:crypto';
import type { WorkspaceDatabase } from '@cantelop/sdk/session';
import type { InStatement } from '@cantelop/sdk/database';
import type { StaleLease } from '../git-protocol.js';
import { setTimeout as delay } from 'node:timers/promises';

type LeaseDatabase = Pick<WorkspaceDatabase, 'execute' | 'transaction'>;
const LEASE_MS = 180_000;

async function busyRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt >= 6 || !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as { code?: string }).code))) throw error;
      await delay(20 * 2 ** attempt);
    }
  }
}

async function writeLease(db: LeaseDatabase, statement: InStatement) {
  return busyRetry(async () => {
    const tx = await db.transaction('write');
    try { const result = await tx.execute(statement); await tx.commit(); return result; }
    finally { tx.close(); }
  });
}

export class CheckoutBusy extends Error {
  constructor(readonly stale: StaleLease[], readonly kind: 'sessions' | 'maintenance' = 'sessions') {
    super(stale.length ? 'A previous session stopped renewing its checkout lease.' : 'This checkout is in use. Close its Claude sessions before syncing to the workspace.');
  }
}

/** Shared SQL is the authority across independent Session sandboxes. */
export async function acquireCheckout(db: LeaseDatabase, project: string, session: string, kind: 'session' | 'maintenance', onLost: (error: Error) => void) {
  await busyRetry(() => db.execute(`CREATE TABLE IF NOT EXISTS juiced_checkout_leases (
    token TEXT PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL,
    kind TEXT NOT NULL, expires INTEGER NOT NULL
  )`));
  const token = randomUUID();
  await busyRetry(async () => {
    const tx = await db.transaction('write');
    try {
      const result = await tx.execute({ sql: 'SELECT token, session, kind, expires FROM juiced_checkout_leases WHERE project = ?', args: [project] });
      const conflicts = result.rows.filter(row => kind === 'maintenance' || row.kind === 'maintenance');
      if (conflicts.length) {
        const stale = conflicts.filter(row => Number(row.expires) < Date.now()).map(row => ({ token: String(row.token), session: String(row.session) }));
        throw new CheckoutBusy(stale, conflicts.every(row => row.kind === 'maintenance') ? 'maintenance' : 'sessions');
      }
      await tx.execute({ sql: 'INSERT INTO juiced_checkout_leases (token, project, session, kind, expires) VALUES (?, ?, ?, ?, ?)', args: [token, project, session, kind, Date.now() + LEASE_MS] });
      await tx.commit();
    } finally { tx.close(); }
  });
  let released = false; let renewing: Promise<void> | undefined;
  const renew = () => renewing ??= (async () => {
    const result = await writeLease(db, { sql: 'UPDATE juiced_checkout_leases SET expires = ? WHERE token = ?', args: [Date.now() + LEASE_MS, token] });
    if (Number(result.rowsAffected) !== 1) throw new Error('The checkout lease was lost');
  })().finally(() => { renewing = undefined; });
  const timer = setInterval(() => { void renew().catch(error => { clearInterval(timer); onLost(error instanceof Error ? error : new Error(String(error))); }); }, 30_000);
  timer.unref();
  return {
    token,
    async release() {
      if (released) return;
      released = true; clearInterval(timer);
      await renewing?.catch(() => {});
      await writeLease(db, { sql: 'DELETE FROM juiced_checkout_leases WHERE token = ?', args: [token] });
    },
  };
}

/** The caller must successfully stop these Sessions before requesting removal. */
export async function reapCheckout(db: LeaseDatabase, project: string, leases: StaleLease[]) {
  for (const lease of leases) {
    await writeLease(db, { sql: 'DELETE FROM juiced_checkout_leases WHERE project = ? AND session = ? AND token = ? AND expires < ?', args: [project, lease.session, lease.token, Date.now()] });
  }
}

export async function acquireSessionCheckout(db: LeaseDatabase, project: string, session: string, signal: AbortSignal, onLost: (error: Error) => void) {
  const deadline = Date.now() + 240_000;
  while (true) {
    signal.throwIfAborted();
    try { return await acquireCheckout(db, project, session, 'session', onLost); }
    catch (error) {
      if (!(error instanceof CheckoutBusy) || error.kind !== 'maintenance' || error.stale.length || Date.now() > deadline) throw error;
      await delay(500, undefined, { signal });
    }
  }
}
