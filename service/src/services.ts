import Stripe from 'stripe';
import { config, required } from './config';
import { database } from './db';
import { Accounts } from './accounts';
import { Platform } from './platform';
import { configuredFleet } from './fleet';
import { Billing } from './billing';
import { VERSION } from '../../src/version';
import { cliVersionAtLeast, isCliVersion } from '../../contracts/cli-version';
import { Telemetry } from './telemetry';

export function services(env: NodeJS.ProcessEnv = process.env, role: 'api' | 'worker' = 'api') {
  const cliVersion = env.JUICED_CLI_VERSION ?? VERSION;
  const minimumCli = env.JUICED_MINIMUM_CLI ?? '0.2.0';
  if (!isCliVersion(cliVersion) || !cliVersionAtLeast(cliVersion, minimumCli))
    throw new Error('JUICED_CLI_VERSION must be a valid release at or above JUICED_MINIMUM_CLI');
  const generation = Number(env.JUICED_RELEASE_GENERATION ?? 0);
  const cfg = config(env),
    pool = database(
      role === 'worker' ? (env.JUICED_WORKER_DATABASE_URL ?? cfg.databaseUrl) : cfg.databaseUrl,
      generation,
    );
  const deployment = configuredFleet(env, role);
  const accounts = new Accounts(pool, {
    packageId: deployment.packageId,
    runtimeId: deployment.runtimeId,
    minimumCli,
    cliVersion,
    generation,
  });
  const platform = new Platform(deployment.fleet);

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
  return { cfg, pool, accounts, platform, billing, telemetry: new Telemetry(env) };
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
        if (env.NODE_ENV === 'production') {
          const row = (await s.pool.query("SELECT row_security_active('jobs') AND row_security_active('installations') AS enforced")).rows[0];
          if (!row?.enforced) throw new Error('Production services require restricted database roles that enforce release row policies');
        }
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
