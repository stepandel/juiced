import { send } from '@vercel/queue';

export interface JobMessage {
  type: 'reconcile';
  expiresAt: number;
}

/** Postgres owns the work. A queue wake-up may only keep itself alive until
 * the next minute cron, even when every attempt publishes a fresh message. */
export function jobWaker(publish = send, now = Date.now) {
  return async (delaySeconds = 0, expiresAt = now() + 60_000) => {
    const time = now();
    // Deliver at the end of the shared slot, after all coalesced callers have
    // committed their work. A completed wake-up cannot swallow a later request.
    const due = Math.ceil((time + Math.max(1, delaySeconds * 1000)) / 5000) * 5000;
    if (due >= expiresAt) return;
    await publish('juiced-jobs', { type: 'reconcile', expiresAt } satisfies JobMessage, {
      delaySeconds: Math.ceil((due - time) / 1000),
      retentionSeconds: 60,
      // Cron, requests and duplicate callbacks share a wake-up within each
      // five-second slot, with separate keys for each deployment.
      idempotencyKey: `reconcile:${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}:${due}`,
    });
  };
}

export const wakeJobs = jobWaker();
