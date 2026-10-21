import { Provisioner } from './provisioning';
import { UsageIngestor } from './usage';
import { TerminalCloser } from './terminals';
import { enqueue } from './accounts';
import { transaction } from './db';
import type { services } from './services';
import type { Billing } from './billing';
import { wakeJobs } from './queue';

/** Bounded work on the existing durable records. Duplicate queue deliveries
 * use the same SQL locks, idempotency keys and projection fences as before. */
type JobServices = Pick<ReturnType<typeof services>, 'pool' | 'accounts' | 'platform'> & {
  billing: Pick<Billing, 'runOnce' | 'cancel'>;
};
export async function reconcile(s: JobServices, wake = wakeJobs) {
  await transaction(s.pool, async (tx) => {
    const expired = await tx.query(
      `UPDATE accounts SET entitlement='inactive' WHERE entitlement='active' AND period_end<=now() RETURNING id,period_id`,
    );
    for (const account of expired.rows)
      await enqueue(
        tx,
        String(account.id),
        'suspend',
        {},
        `expired:${account.id}:${account.period_id}`,
      );
  });
  const provision = new Provisioner(s.pool, s.accounts, s.platform, s.billing);
  const usage = new UsageIngestor(s.pool, s.platform);
  const terminals = new TerminalCloser(s.pool, s.platform);
  const deadline = Date.now() + 20_000;
  let more = false;
  for (let round = 0; round < 25 && Date.now() < deadline; round++) {
    const results = await Promise.allSettled([
      s.billing.runOnce(),
      usage.runOnce(),
      provision.runOnce(),
      terminals.runOnce(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    more = results.some((result) => result.status === 'fulfilled' && result.value);
    if (!more) break;
  }
  // Keep short retries and terminal expiry prompt. The minute cron recovers
  // lost wake-ups, expired queue messages and jobs from previous deployments.
  const next = (
    await s.pool.query<{ due: Date | null }>(`
    SELECT min(due) AS due FROM (
      SELECT CASE WHEN status='running' THEN lease_until ELSE available_at END AS due
        FROM jobs WHERE status IN ('pending','running')
      UNION ALL SELECT next_attempt_at FROM billing_events WHERE processed_at IS NULL
      UNION ALL SELECT greatest(t.close_after,least(t.expires_at,d.expires_at,a.period_end,
        CASE WHEN d.revoked_at IS NOT NULL OR a.status<>'active' OR a.entitlement<>'active'
        THEN now() ELSE 'infinity'::timestamptz END))
        FROM terminal_leases t JOIN devices d ON d.id=t.device_id JOIN accounts a ON a.id=t.account_id
        WHERE t.revoked_at IS NULL
      UNION ALL SELECT period_end FROM accounts WHERE entitlement='active'
    ) pending
  `)
  ).rows[0]!.due;
  if (more) await wake();
  else if (next && next.getTime() <= Date.now() + 60_000)
    await wake(Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000)));
}
