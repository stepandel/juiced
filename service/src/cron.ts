import { timingSafeEqual } from 'node:crypto';
import { serviceLoader } from './services';
import { wakeJobs } from './queue';
import { logError } from './log';

export function cronHandler(
  env: NodeJS.ProcessEnv = process.env,
  wake = wakeJobs,
  ready: () => Promise<unknown> = serviceLoader('worker', env),
) {
  return async (request: Request) => {
    const secret = env.CRON_SECRET;
    if (!secret) return Response.json({ error: 'service_unavailable' }, { status: 503 });
    const received = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      // Do not publish a stream of doomed jobs before account setup is complete.
      await ready();
      await wake();
      return Response.json(
        { queued: true },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      logError('cron_failed', error);
      return Response.json(
        { error: 'service_unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}
