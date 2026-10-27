import { reconcile } from './jobs';
import { wakeJobs, type JobMessage } from './queue';
import type { services } from './services';
import type { RetryHandler } from '@vercel/queue';

export function jobHandler(
  load: () => Promise<ReturnType<typeof services>>,
  run = reconcile,
  wake = wakeJobs,
  now = Date.now,
) {
  return async (message: unknown) => {
    const job = message as Partial<JobMessage> | null;
    const expiresAt = job?.expiresAt;
    const time = now();
    // Also acknowledge legacy wake-ups without a deadline. The minute cron
    // recovers durable work; replaying old wake-ups must not create new chains.
    if (!job || job.type !== 'reconcile' || typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= time || expiresAt > time + 60_000) return;
    await run(await load(), (delay) => wake(delay, expiresAt));
  };
}

// A broken database or configuration must not retry a message forever.
// Durable jobs remain in Postgres and the next cron can retry them.
export const jobRetry: RetryHandler = (_error, metadata) =>
  metadata.deliveryCount >= 3
    ? { acknowledge: true }
    : { afterSeconds: 5 * 2 ** Math.max(0, metadata.deliveryCount - 1) };
