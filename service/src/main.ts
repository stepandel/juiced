import { pathToFileURL } from 'node:url';
import { clientIP } from './client-ip.js';
import { serve } from '@hono/node-server';
import Stripe from 'stripe';
import { config, required } from './config.js';
import { database } from './db.js';
import { Accounts } from './accounts.js';
import { Platform } from './platform.js';
import { Billing } from './billing.js';
import { application } from './app.js';

export function services(env: NodeJS.ProcessEnv = process.env, role: 'api' | 'worker' = 'api') {
  const cfg = config(env),
    pool = database(
      role === 'worker' ? (env.JUICED_WORKER_DATABASE_URL ?? cfg.databaseUrl) : cfg.databaseUrl,
    );
  const accounts = new Accounts(pool, {
    packageId: required(env, 'JUICED_PACKAGE_ID'),
    runtimeId: required(env, 'JUICED_RUNTIME_ID'),
    minimumCli: env.JUICED_MINIMUM_CLI ?? '0.2.0',
  });
  const platform = new Platform(
    required(env, 'CANTELOP_API_URL'),
    required(env, 'CANTELOP_FLEET_ID'),
    required(env, role === 'worker' ? 'CANTELOP_WORKER_FLEET_TOKEN' : 'CANTELOP_FLEET_TOKEN'),
    fetch,
    cfg.development,
  );
  const billing = new Billing(
    pool,
    new Stripe(required(env, 'STRIPE_SECRET_KEY'), { timeout: 15000, maxNetworkRetries: 2 }),
    {
      price: required(env, 'STRIPE_PRICE_ID'),
      credits: Number(required(env, 'JUICED_INCLUDED_CREDITS')),
      webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
      origin: cfg.origin,
      liveMode: env.STRIPE_LIVE_MODE === 'true',
      portalConfiguration: required(env, 'STRIPE_PORTAL_CONFIGURATION_ID'),
    },
  );
  return { cfg, pool, accounts, platform, billing };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = services();
  await s.billing.check();
  const { app } = application(s);
  const server = serve({
    fetch: (request, env) => {
      const headers = new Headers(request.headers),
        ip = clientIP(
          env.incoming.socket.remoteAddress,
          headers.get('x-forwarded-for'),
          s.cfg.trustedProxies,
        );
      headers.delete('x-juiced-peer-ip');
      if (ip) headers.set('x-juiced-peer-ip', ip);
      return app.fetch(new Request(request, { headers }));
    },
    hostname: '0.0.0.0',
    port: s.cfg.port,
  });
  const shutdown = () => {
    server.close(() => void s.pool.end());
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
