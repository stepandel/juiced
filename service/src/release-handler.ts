import { timingSafeEqual } from 'node:crypto';
import { serviceLoader } from './services';
import { promoteRelease } from './release';
import { wakeJobs } from './queue';
import { logError } from './log';
import { ServiceError } from './config';

/** Public operator readiness metadata; no account data or deployment credentials. */
export function releaseStatusHandler(load = serviceLoader('api')) {
  return async () => {
    try {
      const s = await load();
      const row = (await s.pool.query('SELECT generation FROM juiced_release')).rows[0];
      return Response.json({ generation: Number(row?.generation ?? 0) },
        { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      logError('release_status_failed', error);
      return Response.json({ error: 'service_unavailable' }, { status: 503 });
    }
  };
}

export function releaseHandler(
  env: NodeJS.ProcessEnv = process.env,
  load = serviceLoader('worker', env),
  promote = promoteRelease,
  wake = wakeJobs,
) {
  return async (request: Request) => {
    const secret = env.JUICED_RELEASE_TOKEN;
    const generation = Number(env.JUICED_RELEASE_GENERATION);
    if (!secret || !Number.isSafeInteger(generation) || generation <= 0)
      return Response.json({ error: 'service_unavailable' }, { status: 503 });
    const received = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      const s = await load();
      const queued = await promote(s.pool, s.accounts.release);
      await wake();
      return Response.json({ generation, packageId: s.accounts.release.packageId,
        runtimeId: s.accounts.release.runtimeId, queued }, { status: 202,
        headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      logError('release_promotion_failed', error);
      const superseded = error instanceof ServiceError && error.code === 'release_superseded';
      return Response.json({ error: superseded ? 'release_superseded' : 'service_unavailable' },
        { status: superseded ? 409 : 503 });
    }
  };
}
