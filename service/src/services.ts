import Stripe from 'stripe';
import { config, required } from './config';
import { database } from './db';
import { Accounts } from './accounts';
import { Platform } from './platform';
import { Billing } from './billing';

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

export function serviceLoader(
  role: 'api' | 'worker' = 'api',
  env: NodeJS.ProcessEnv = process.env,
) {
  let pending: Promise<ReturnType<typeof services>> | undefined;
  return () => {
    pending ??= (async () => {
      const s = services(env, role);
      try {
        await s.pool.query('SELECT 1 FROM juiced_migrations LIMIT 1');
        // Billing jobs need Stripe. Requests check it lazily in Billing, so a
        // Stripe outage cannot take down sign-in or runtime access.
        if (role === 'worker') await s.billing.ready();
        return s;
      } catch (error) {
        await s.pool.end();
        throw error;
      }
    })().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
