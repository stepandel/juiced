import { handleCallback } from '@vercel/queue';
import { serviceLoader } from '../../../src/services';
import { reconcile } from '../../../src/jobs';

export const runtime = 'nodejs';
export const maxDuration = 300;
const load = serviceLoader('worker');

// Vercel's queue trigger makes this function private to queue delivery.
export const POST = handleCallback(async (message: unknown) => {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { type?: unknown }).type !== 'reconcile'
  )
    throw new Error('Invalid Juiced job');
  await reconcile(await load());
});
