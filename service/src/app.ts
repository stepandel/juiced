import { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  authentication,
  authHandler,
  authenticate,
  CLIENT_ID,
  type Identity,
  type Auth,
} from './auth.js';
import { Accounts, publicInstallation, enqueue } from './accounts.js';
import type { Platform } from './platform.js';
import { ServiceError, readText, type Config } from './config.js';
import { bodyLimit } from 'hono/body-limit';
import { relay } from './relay.js';
import { stopGitSession } from './git-stop.js';
import type { Billing } from './billing.js';
import { transaction } from './db.js';
import { page, signIn, devicePage, accountPage } from './pages.js';

export interface Services {
  pool: Pool;
  cfg: Config;
  accounts: Accounts;
  platform: Platform;
  auth?: Auth;
  billing?: Billing;
}
export function application(s: Services) {
  const app = new Hono<{ Variables: { identity: Identity } }>(),
    auth = s.auth ?? authentication(s.pool, s.cfg);
  app.onError((error, c) => {
    const known = error instanceof ServiceError;
    if (known && error.status === 429) c.header('Retry-After', '60');
    c.header('X-Juiced-Error', '1');
    return c.json(
      { error: known ? error.code : 'service_unavailable' },
      known ? (error.status as 400) : 503,
    );
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (s.cfg.origin.startsWith('https:'))
      c.header('Strict-Transport-Security', 'max-age=31536000');
    c.header('X-Request-ID', crypto.randomUUID());
    await next();
  });
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    await s.pool.query('SELECT 1 FROM juiced_migrations LIMIT 1');
    return c.json({ status: 'ready' });
  });
  app.get('/v1/config', (c) =>
    c.json({
      clientId: CLIENT_ID,
      issuer: s.cfg.origin,
      resource: s.cfg.origin,
      scope: 'juiced offline_access',
      deviceEndpoint: '/api/auth/device/code',
      tokenEndpoint: '/api/auth/oauth2/token',
    }),
  );
  app.use('/api/auth/*', bodyLimit({ maxSize: 16 * 1024 }));
  app.all('/api/auth/*', (c) => authHandler(auth, s.pool, c.req.raw));
  app.get('/sign-in', (c) => {
    const code = c.req.query('user_code') ?? '';
    return signIn(code ? `/device?user_code=${encodeURIComponent(code)}` : '/account');
  });
  app.get('/device', async (c) => {
    const user = await auth.api.getSession({ headers: c.req.raw.headers });
    const code = c.req.query('user_code') ?? '';
    if (!user) return c.redirect(`/sign-in?user_code=${encodeURIComponent(code)}`);
    await s.accounts.ensure(user.user.id);
    return devicePage(code);
  });
  app.get('/account', () => accountPage());
  app.post('/webhooks/stripe', async (c) => {
    if (!s.billing) throw new ServiceError('billing_unavailable', 503);
    return c.json(await s.billing.webhook(c.req.raw));
  });
  app.use('/v1/*', async (c, next) => {
    if (c.req.header('authorization'))
      c.set('identity', await authenticate(s.pool, s.cfg, c.req.raw));
    else {
      if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('origin') !== s.cfg.origin)
        throw new ServiceError('origin_required', 403);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) throw new ServiceError('not_signed_in', 401);
      c.set('identity', {
        userId: session.user.id,
        deviceId: `browser:${session.session.id}`,
        expiresAt: session.session.expiresAt.getTime(),
      });
    }
    const key = `device:${c.get('identity').deviceId}`,
      bucket = Math.floor(Date.now() / 60000);
    const count = (
      await s.pool.query(
        `INSERT INTO api_limits(key,bucket,count) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN api_limits.bucket=excluded.bucket THEN api_limits.count+1 ELSE 1 END RETURNING count`,
        [key, bucket],
      )
    ).rows[0]!.count;
    if (count > 1200) throw new ServiceError('rate_limit_exceeded', 429);
    await next();
  });
  app.get('/v1/me', async (c) => {
    const who = c.get('identity');
    await s.accounts.ensure(who.userId);
    const accounts = (
      await s.pool.query(
        'SELECT a.id,a.status,a.entitlement,a.period_end FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=$1',
        [who.userId],
      )
    ).rows;
    return c.json({ userId: who.userId, deviceId: who.deviceId, accounts });
  });
  app.get('/v1/devices', async (c) =>
    c.json({
      items: (
        await s.pool.query(
          'SELECT id,label,created_at,expires_at,revoked_at FROM devices WHERE user_id=$1',
          [c.get('identity').userId],
        )
      ).rows,
    }),
  );
  app.delete('/v1/devices/:device', async (c) => {
    const updated = await s.pool.query(
      'UPDATE devices SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id',
      [c.req.param('device'), c.get('identity').userId],
    );
    if (!updated.rowCount) throw new ServiceError('not_found', 404);
    await s.pool.query("INSERT INTO audit(actor,action,target) VALUES($1,'device.revoke',$2)", [
      c.get('identity').userId,
      c.req.param('device'),
    ]);
    return c.json({ revoked: true });
  });
  app.post('/v1/logout', async (c) => {
    const input = await jsonBody(c.req.raw),
      who = c.get('identity');
    await s.pool.query(
      'UPDATE devices SET revoked_at=now() WHERE user_id=$1 AND ($2::boolean OR id=$3)',
      [who.userId, input.all === true, who.deviceId],
    );
    return c.json({ revoked: true });
  });
  app.post('/v1/accounts/:account/billing/:action', async (c) => {
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account'), true);
    if (!s.billing) throw new ServiceError('billing_unavailable', 503);
    if (c.req.param('action') === 'checkout') return c.json(await s.billing.checkout(a));
    if (c.req.param('action') === 'portal') return c.json(await s.billing.portal(a));
    throw new ServiceError('not_found', 404);
  });
  app.get('/v1/accounts/:account/usage', async (c) => {
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account'));
    const used = (
      await s.pool.query(
        `SELECT coalesce(sum(credits),0)::text AS used FROM usage_events WHERE account_id=$1 AND payload->>'epoch'=$2`,
        [a.id, a.period_id],
      )
    ).rows[0]!.used;
    return c.json({
      included: a.included_credits,
      used,
      periodEnd: a.period_end,
      entitlement: a.entitlement,
      rateCard: 'allocated-compute-v1',
      pending: true,
    });
  });
  app.delete('/v1/accounts/:account', async (c) => {
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account'), true),
      input = await jsonBody(c.req.raw);
    if (input.confirmation !== a.id) throw new ServiceError('confirmation_required');
    await transaction(s.pool, async (tx) => {
      await tx.query(`UPDATE accounts SET status='deleting',entitlement='inactive' WHERE id=$1`, [
        a.id,
      ]);
      await tx.query(`UPDATE devices SET revoked_at=now() WHERE user_id=$1`, [a.owner_user_id]);
      await tx.query(
        `INSERT INTO audit(account_id,actor,action,target) VALUES($1,$2,'account.delete',$1)`,
        [a.id, c.get('identity').userId],
      );
      await enqueue(tx, a.id, 'delete', {}, `delete:${a.id}`);
    });
    return c.json({ status: 'deleting' }, 202);
  });
  app.post('/v1/accounts/:account/bootstrap', async (c) => {
    if (!s.cfg.admissionEnabled) throw new ServiceError('admission_closed', 503);
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account'));
    return c.json(await s.accounts.bootstrap(a, await jsonBody(c.req.raw)));
  });
  app.get('/v1/accounts/:account/installation', async (c) => {
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account')),
      i = await s.accounts.installation(a.id);
    if (!i) throw new ServiceError('not_found', 404);
    return c.json(publicInstallation(i, s.accounts.release.minimumCli));
  });
  app.get('/v1/accounts/:account/operations/:operation', async (c) => {
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account'));
    const row = (
      await s.pool.query(
        'SELECT kind,status,error_code,attempts FROM jobs WHERE account_id=$1 AND idempotency_key=$2',
        [a.id, c.req.param('operation')],
      )
    ).rows[0];
    if (!row) throw new ServiceError('not_found', 404);
    return c.json(row);
  });
  app.all('/v1/accounts/:account/runtime/*', async (c) => {
    const identity = c.get('identity');
    if (identity.deviceId.startsWith('browser:')) throw new ServiceError('device_required', 401);
    const account = await s.accounts.authorize(identity, c.req.param('account')),
      installation = await s.accounts.installation(account.id);
    if (!installation) throw new ServiceError('installation_pending', 409);
    if (
      !s.cfg.admissionEnabled &&
      ![
        '/commands/stop',
        '/commands/cancel',
        '/commands/view',
        '/commands/stream',
        '/commands/status',
        '/commands/workspace.inspect',
        '/commands/workspace.delete',
      ].some((p) => new URL(c.req.url).pathname.endsWith(p))
    )
      throw new ServiceError('admission_closed', 503);
    const prefix = `/v1/accounts/${c.req.param('account')}/runtime`;
    const url = new URL(c.req.url);
    return relay(c.req.raw, url.pathname.slice(prefix.length) + url.search, {
      ...s,
      identity,
      account,
      installation,
    });
  });
  app.post('/v1/accounts/:account/git-sessions/:session/stop', async (c) => {
    const a = await s.accounts.authorize(c.get('identity'), c.req.param('account')),
      i = await s.accounts.installation(a.id);
    if (!i || c.req.header('x-juiced-installation') !== i.id)
      throw new ServiceError('installation_changed', 409);
    await stopGitSession(s.platform, i, c.req.param('session'), await jsonBody(c.req.raw));
    return c.json({ stopped: true });
  });
  return { app, auth };
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request, 16 * 1024);
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v as Record<string, unknown>;
  } catch {
    throw new ServiceError('invalid_request');
  }
}
