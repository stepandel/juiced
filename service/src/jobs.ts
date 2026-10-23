import { Provisioner } from './provisioning';
import { TerminalCloser } from './terminals';
import { enqueue } from './accounts';
import { transaction } from './db';
import type { services } from './services';
import type { Billing } from './billing';
import { wakeJobs } from './queue';
import { logError } from './log';
import { currentRelease } from './release';

/** Bounded work on the existing durable records. Duplicate queue deliveries
 * use the same SQL locks, idempotency keys and projection fences as before. */
type JobServices = Pick<ReturnType<typeof services>, 'pool' | 'accounts' | 'platform'> & {
  billing?: Pick<Billing, 'runOnce' | 'cancel'> | undefined;
};
export async function reconcile(s: JobServices, wake = wakeJobs) {
  if (!await currentRelease(s.pool, s.accounts.release)) return;
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
  const terminals = new TerminalCloser(s.pool, s.platform);
  const workers: Array<{ name: string; run(): Promise<boolean> } | undefined> = [
    { name: 'billing', run: () => s.billing?.runOnce() ?? Promise.resolve(false) },
    { name: 'provisioning', run: () => provision.runOnce() },
    { name: 'terminals', run: () => terminals.runOnce() },
  ];
  let retry = false;
  const deadline = Date.now() + 20_000;
  let more = false;
  for (let round = 0; round < 25 && Date.now() < deadline; round++) {
    if (!await currentRelease(s.pool, s.accounts.release)) return;
    const results = await Promise.allSettled(workers.map((worker) => worker?.run() ?? false));
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue;
      logError('job_worker_failed', result.reason, { worker: workers[index]!.name });
      retry = true;
      // A failed worker must not starve provisioning, billing or cleanup.
      // Retry the failed worker on the next queue delivery, after other queues
      // have advanced and their durable retry times have been scheduled.
      workers[index] = undefined;
    }
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
  let delay = more ? 0 : Infinity;
  if (next && next.getTime() <= Date.now() + 60_000)
    delay = Math.min(delay, Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000)));
  // Publish one retry, shared with the next healthy job's wake-up. Rethrowing
  // after publishing would also redeliver the current message and multiply
  // retries. A failed publish still throws so queue redelivery/cron can recover.
  if (retry) delay = Math.min(delay, 10);
  if (Number.isFinite(delay) && await currentRelease(s.pool, s.accounts.release)) await wake(delay);
}
