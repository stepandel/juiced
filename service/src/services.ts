import Stripe from 'stripe';
import { config, required } from './config';
import { database } from './db';
import { Accounts } from './accounts';
import { Platform } from './platform';
import { Billing } from './billing';
import { VERSION } from '../../src/version';
import { cliVersionAtLeast, isCliVersion } from '../../contracts/cli-version';

export function services(env: NodeJS.ProcessEnv = process.env, role: 'api' | 'worker' = 'api') {
  const cliVersion = env.JUICED_CLI_VERSION ?? VERSION;
  const minimumCli = env.JUICED_MINIMUM_CLI ?? '0.2.0';
  if (!isCliVersion(cliVersion) || !cliVersionAtLeast(cliVersion, minimumCli))
    throw new Error('JUICED_CLI_VERSION must be a valid release at or above JUICED_MINIMUM_CLI');
  const cfg = config(env),
    pool = database(
      role === 'worker' ? (env.JUICED_WORKER_DATABASE_URL ?? cfg.databaseUrl) : cfg.databaseUrl,
    );
  const accounts = new Accounts(pool, {
    packageId: required(env, 'JUICED_PACKAGE_ID'),
    runtimeId: required(env, 'JUICED_RUNTIME_ID'),
    minimumCli,
    cliVersion,
  });
  const platform = new Platform(
    required(env, 'CANTELOP_API_URL'),
    required(env, 'CANTELOP_FLEET_ID'),
    required(env, role === 'worker' ? 'CANTELOP_WORKER_FLEET_TOKEN' : 'CANTELOP_FLEET_TOKEN'),
    fetch,
    cfg.development,
  );
  // Billing is enabled by STRIPE_SECRET_KEY. Without it, billing routes return
  // billing_unavailable and accounts use the default free allowance.
  const billing = env.STRIPE_SECRET_KEY
    ? new Billing(
        pool,
        new Stripe(env.STRIPE_SECRET_KEY, { timeout: 15000, maxNetworkRetries: 2 }),
        {
          price: required(env, 'STRIPE_PRICE_ID'),
          credits: Number(required(env, 'JUICED_INCLUDED_CREDITS')),
          webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
          origin: cfg.origin,
          liveMode: env.STRIPE_LIVE_MODE === 'true',
          portalConfiguration: required(env, 'STRIPE_PORTAL_CONFIGURATION_ID'),
        },
      )
    : undefined;
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
        // Billing jobs need Stripe when it is configured. Requests check it lazily, so a
        // Stripe outage cannot take down sign-in or runtime access.
        if (role === 'worker') await s.billing?.ready();
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
