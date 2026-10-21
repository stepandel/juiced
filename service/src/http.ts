import { isIP } from 'node:net';
import { application } from './app';
import { serviceLoader } from './services';
import { page } from './pages';
import { wakeJobs } from './queue';

/** Only Vercel ingress may supply the authentication rate-limit identity. */
export function vercelRequest(request: Request, env: Record<string, string | undefined>) {
  const headers = new Headers(request.headers);
  headers.delete('x-juiced-peer-ip');
  const ip = headers.get('x-vercel-forwarded-for')?.trim();
  if (env.VERCEL === '1' && ip && isIP(ip)) headers.set('x-juiced-peer-ip', ip);
  return new Request(request, { headers });
}

export function requestHandler(env: NodeJS.ProcessEnv = process.env) {
  const load = serviceLoader('api', env);
  let handle: ReturnType<typeof application> | undefined;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (['GET', 'HEAD'].includes(request.method) && url.pathname === '/health')
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    if (
      !['/ready', '/sign-in', '/account', '/device', '/webhooks/stripe'].includes(url.pathname) &&
      !url.pathname.startsWith('/api/auth/') &&
      !url.pathname.startsWith('/v1/')
    )
      return new Response('Not found', { status: 404 });
    try {
      handle ??= application({ ...(await load()), wake: wakeJobs });
      return await handle(vercelRequest(request, env));
    } catch {
      const headers = { 'Cache-Control': 'no-store', 'X-Juiced-Error': '1', 'Retry-After': '60' };
      if (request.method === 'GET' && ['/sign-in', '/account', '/device'].includes(url.pathname)) {
        const response = page(
          'Juiced is getting ready',
          '<p>Account access is not available yet. Please check back soon.</p><p><a href="/">Back to Juiced</a></p>',
        );
        return new Response(response.body, {
          status: 503,
          headers: { ...Object.fromEntries(response.headers), ...headers },
        });
      }
      return Response.json({ error: 'service_unavailable' }, { status: 503, headers });
    }
  };
}
export const handleRequest = requestHandler();
