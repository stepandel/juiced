import { send } from '@vercel/queue';

/** A wake-up signal only. Postgres retains the authoritative job and retry state. */
export async function wakeJobs(delaySeconds = 0) {
  await send('juiced-jobs', { type: 'reconcile' }, { delaySeconds });
}
