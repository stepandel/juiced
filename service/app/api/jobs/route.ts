import { handleCallback } from '@vercel/queue';
import { serviceLoader } from '../../../src/services';
import { jobHandler, jobRetry } from '../../../src/job-handler';
import { logError } from '../../../src/log';

export const runtime = 'nodejs';
export const maxDuration = 300;
const load = serviceLoader('worker');
const handle = jobHandler(load);

// Vercel's queue trigger makes this function private to queue delivery.
export const POST = handleCallback(async (message: unknown) => {
  try {
    await handle(message);
  } catch (error) {
    // Rethrow so the queue redelivers; the cron recovers if it gives up.
    logError('jobs_failed', error);
    throw error;
  }
}, { retry: jobRetry });
