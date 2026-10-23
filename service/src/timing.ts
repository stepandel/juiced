import { AsyncLocalStorage } from 'node:async_hooks';

type Phase = 'auth' | 'rate_limit' | 'account' | 'installation' | 'bootstrap' | 'job_wake' | 'fleet_connection' | 'edge' | 'service_init';
const active = new AsyncLocalStorage<Array<{ phase: Phase; duration: number }>>();

/** Fixed phase names only: no SQL, URLs, credentials, or customer content. */
export async function timed<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
  const metrics = active.getStore();
  if (!metrics) return work();
  const start = performance.now();
  try { return await work(); }
  finally { if (metrics.length < 32) metrics.push({ phase, duration: performance.now() - start }); }
}

/** Preserve streaming responses; a nested application shares the HTTP scope. */
export async function withRequestTiming(request: Request, work: () => Promise<Response>): Promise<Response> {
  if (request.headers.get('x-juiced-timing') !== '1' || active.getStore()) return work();
  return active.run([], async () => {
    const start = performance.now();
    const response = await work();
    const metrics = active.getStore()!;
    const headers = new Headers(response.headers);
    headers.set('Server-Timing', [...metrics.map(metric => `${metric.phase};dur=${metric.duration.toFixed(1)}`), `service_total;dur=${(performance.now() - start).toFixed(1)}`].join(', '));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}
