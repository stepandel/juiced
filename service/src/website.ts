import { isIP } from 'node:net';
import { Hono } from 'hono';
import { application } from './app.js';
import { services } from './main.js';
import { landingPage } from './landing.js';
import { page } from './pages.js';

/** Vercel owns the ingress and overwrites this header. Never trust the private
 * identity header sent by a visitor, or use Vercel headers on the Node server. */
export function vercelRequest(request: Request, env: NodeJS.ProcessEnv) {
  const headers = new Headers(request.headers);
  headers.delete('x-juiced-peer-ip');
  if (env.VERCEL === '1') {
    const ip = headers.get('x-vercel-forwarded-for')?.trim();
    if (ip && isIP(ip)) headers.set('x-juiced-peer-ip', ip);
  }
  return new Request(request, { headers });
}

/** Public pages do not need account credentials. Initialize the account API
 * lazily, sharing its pool across concurrent requests in a function instance. */
export function website(env: NodeJS.ProcessEnv = process.env) {
  const app = new Hono();
  let initialized: Promise<ReturnType<typeof application>['app']> | undefined;
  function accountService() {
    initialized ??= (async () => {
      const s = services(env);
      try {
        await s.billing.check();
        return application(s).app;
      } catch (error) {
        await s.pool.end();
        throw error;
      }
    })().catch((error: unknown) => {
      initialized = undefined;
      console.error('Juiced account service initialization failed. Check deployment configuration.');
      throw error;
    });
    return initialized;
  }
  app.get('/', () => landingPage());
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.all('*', async (c) => {
    if (!['/ready', '/sign-in', '/account', '/device', '/webhooks/stripe'].includes(c.req.path) &&
      !c.req.path.startsWith('/api/auth/') && !c.req.path.startsWith('/v1/')) return c.notFound();
    try {
      return await (await accountService()).fetch(vercelRequest(c.req.raw, env));
    } catch {
      c.header('Cache-Control', 'no-store');
      c.header('X-Juiced-Error', '1');
      c.header('Retry-After', '60');
      if (c.req.method === 'GET' && ['/sign-in', '/account', '/device'].includes(c.req.path)) {
        const response = page('Juiced is getting ready', '<p>Account access is not available yet. Please check back soon.</p><p><a href="/">Back to Juiced</a></p>');
        return new Response(response.body, { status: 503, headers: { ...Object.fromEntries(response.headers), 'Retry-After': '60' } });
      }
      return c.json({ error: 'service_unavailable' }, 503);
    }
  });
  return app;
}
