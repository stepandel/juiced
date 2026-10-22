import type { Pool } from 'pg';
import {
  authentication,
  authHandler,
  authenticate,
  CLIENT_ID,
  type Identity,
  type Auth,
} from './auth';
import { Accounts, publicInstallation, enqueue } from './accounts';
import type { Platform } from './platform';
import { ServiceError, readText, type Config } from './config';
import { relay } from './relay';
import { stopGitSession } from './git-stop';
import type { Billing } from './billing';
import { transaction } from './db';
import { signIn, devicePage, accountPage } from './pages';
import { logError } from './log';
import type { Telemetry } from './telemetry';

export interface Services {
  pool: Pool;
  cfg: Config;
  accounts: Accounts;
  platform: Platform;
  auth?: Auth;
  billing?: Billing | undefined;
  telemetry?: Telemetry | undefined;
  wake?: (delaySeconds?: number) => Promise<void>;
}

/** Web-standard handlers shared by Next.js and the service integration tests. */
export function application(s: Services) {
  const auth = s.auth ?? authentication(s.pool, s.cfg);
  async function identity(request: Request): Promise<Identity> {
    let who: Identity;
    if (request.headers.get('authorization')) who = await authenticate(s.pool, s.cfg, request);
    else {
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        request.headers.get('origin') !== s.cfg.origin
      )
        throw new ServiceError('origin_required', 403);
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) throw new ServiceError('not_signed_in', 401);
      who = {
        userId: session.user.id,
        deviceId: `browser:${session.session.id}`,
        expiresAt: session.session.expiresAt.getTime(),
      };
    }
    const count = (
      await s.pool.query(
        `INSERT INTO api_limits(key,bucket,count) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN api_limits.bucket=excluded.bucket THEN api_limits.count+1 ELSE 1 END RETURNING count`,
        [`device:${who.deviceId}`, Math.floor(Date.now() / 60000)],
      )
    ).rows[0]!.count;
    if (count > 1200) throw new ServiceError('rate_limit_exceeded', 429);
    return who;
  }
  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (method === 'GET' && path === '/health') return Response.json({ status: 'ok' });
    if (method === 'POST' && path === '/v1/telemetry')
      return s.telemetry ? s.telemetry.receive(request, s.pool, s.cfg) : new Response(null, { status: 204 });
    if (method === 'GET' && path === '/ready') {
      await s.pool.query('SELECT 1 FROM juiced_migrations LIMIT 1');
      await s.billing?.ready();
      return Response.json({ status: 'ready' });
    }
    if (method === 'GET' && path === '/v1/config')
      return Response.json({
        clientId: CLIENT_ID,
        issuer: s.cfg.origin,
        resource: s.cfg.origin,
        scope: 'juiced offline_access',
        cliVersion: s.accounts.release.cliVersion,
        deviceEndpoint: '/api/auth/device/code',
        tokenEndpoint: '/api/auth/oauth2/token',
      });
    if (path.startsWith('/api/auth/')) {
      if (request.body)
        request = new Request(request, { body: await readText(request, 16 * 1024) });
      return authHandler(auth, s.pool, request, s.telemetry);
    }
    if (method === 'GET' && path === '/sign-in') {
      const code = url.searchParams.get('user_code') ?? '';
      return signIn(code ? `/device?user_code=${encodeURIComponent(code)}` : '/account');
    }
    if (method === 'GET' && path === '/device') {
      const user = await auth.api.getSession({ headers: request.headers });
      const code = url.searchParams.get('user_code') ?? '';
      if (!user)
        return Response.redirect(
          new URL(`/sign-in?user_code=${encodeURIComponent(code)}`, url),
          302,
        );
      await s.accounts.ensure(user.user.id);
      return devicePage(code);
    }
    if (method === 'GET' && path === '/account') {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return Response.redirect(new URL('/sign-in', url), 302);
      const user = session.user.id,
        account = await s.accounts.ensure(user);
      const installation = await s.accounts.installation(account.id);
      const [used, devices, providers] = await Promise.all([
        s.pool.query(
          `SELECT coalesce(sum(credits),0)::text AS used FROM usage_events WHERE account_id=$1 AND payload->>'epoch'=$2`,
          [account.id, account.period_id],
        ),
        s.pool.query(
          'SELECT id,label,created_at,expires_at FROM devices WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
          [user],
        ),
        s.pool.query('SELECT "providerId" AS provider FROM account WHERE "userId"=$1', [user]),
      ]);
      return accountPage({
        user: session.user,
        account,
        installation: installation && {
          status: installation.desired_package_id ? 'upgrading' : installation.status,
          error: installation.error_code,
        },
        used: used.rows[0]!.used,
        devices: devices.rows,
        providers: providers.rows.map((r) => r.provider),
      });
    }
    if (method === 'POST' && path === '/webhooks/stripe') {
      if (!s.billing) throw new ServiceError('billing_unavailable', 503);
      const result = await s.billing.webhook(request);
      await s.wake?.();
      return Response.json(result);
    }
    if (!path.startsWith('/v1/')) return new Response('Not found', { status: 404 });
    const who = await identity(request);
    if (method === 'GET' && path === '/v1/me') {
      await s.accounts.ensure(who.userId);
      const accounts = (
        await s.pool.query(
          'SELECT a.id,a.status,a.entitlement,a.period_end FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=$1',
          [who.userId],
        )
      ).rows;
      return Response.json({ userId: who.userId, deviceId: who.deviceId, accounts });
    }
    if (method === 'GET' && path === '/v1/devices')
      return Response.json({
        items: (
          await s.pool.query(
            'SELECT id,label,created_at,expires_at,revoked_at FROM devices WHERE user_id=$1',
            [who.userId],
          )
        ).rows,
      });
    const device = /^\/v1\/devices\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && device) {
      const id = decodeURIComponent(device[1]!);
      const updated = await s.pool.query(
        'UPDATE devices SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id',
        [id, who.userId],
      );
      if (!updated.rowCount) throw new ServiceError('not_found', 404);
      await s.pool.query("INSERT INTO audit(actor,action,target) VALUES($1,'device.revoke',$2)", [
        who.userId,
        id,
      ]);
      await s.wake?.();
      return Response.json({ revoked: true });
    }
    if (method === 'POST' && path === '/v1/logout') {
      const input = await jsonBody(request);
      await s.pool.query(
        'UPDATE devices SET revoked_at=now() WHERE user_id=$1 AND ($2::boolean OR id=$3)',
        [who.userId, input.all === true, who.deviceId],
      );
      await s.wake?.();
      return Response.json({ revoked: true });
    }
    const match = /^\/v1\/accounts\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) return new Response('Not found', { status: 404 });
    const accountId = decodeURIComponent(match[1]!),
      action = match[2] ?? '';
    const owner =
      (method === 'DELETE' && action === '') ||
      (method === 'POST' && action.startsWith('billing/'));
    const a = await s.accounts.authorize(who, accountId, owner);
    if (method === 'POST' && action.startsWith('billing/')) {
      if (!s.billing) throw new ServiceError('billing_unavailable', 503);
      if (action === 'billing/checkout') return Response.json(await s.billing.checkout(a));
      if (action === 'billing/portal') return Response.json(await s.billing.portal(a));
      throw new ServiceError('not_found', 404);
    }
    if (method === 'GET' && action === 'usage') {
      const used = (
        await s.pool.query(
          `SELECT coalesce(sum(credits),0)::text AS used FROM usage_events WHERE account_id=$1 AND payload->>'epoch'=$2`,
          [a.id, a.period_id],
        )
      ).rows[0]!.used;
      return Response.json({
        included: a.included_credits,
        used,
        periodEnd: a.period_end,
        entitlement: a.entitlement,
        rateCard: 'allocated-compute-v1',
        pending: true,
      });
    }
    if (method === 'DELETE' && action === '') {
      const input = await jsonBody(request);
      if (input.confirmation !== a.id) throw new ServiceError('confirmation_required');
      await transaction(s.pool, async (tx) => {
        await tx.query("UPDATE accounts SET status='deleting',entitlement='inactive' WHERE id=$1", [
          a.id,
        ]);
        await tx.query('UPDATE devices SET revoked_at=now() WHERE user_id=$1', [a.owner_user_id]);
        await tx.query(
          "INSERT INTO audit(account_id,actor,action,target) VALUES($1,$2,'account.delete',$1)",
          [a.id, who.userId],
        );
        await enqueue(tx, a.id, 'delete', {}, `delete:${a.id}`);
      });
      await s.wake?.();
      return Response.json({ status: 'deleting' }, { status: 202 });
    }
    if (method === 'POST' && action === 'bootstrap') {
      if (!s.cfg.admissionEnabled) throw new ServiceError('admission_closed', 503);
      const installation = await s.accounts.bootstrap(a, await jsonBody(request));
      await s.wake?.();
      return Response.json(installation);
    }
    if (method === 'GET' && action === 'installation') {
      const i = await s.accounts.installation(a.id);
      if (!i) throw new ServiceError('not_found', 404);
      return Response.json(publicInstallation(i, s.accounts.release.minimumCli));
    }
    if (method === 'GET' && /^operations\/[^/]+$/.test(action)) {
      const row = (
        await s.pool.query(
          'SELECT kind,status,error_code,attempts FROM jobs WHERE account_id=$1 AND idempotency_key=$2',
          [a.id, decodeURIComponent(action.slice('operations/'.length))],
        )
      ).rows[0];
      if (!row) throw new ServiceError('not_found', 404);
      return Response.json(row);
    }
    if (action.startsWith('runtime/')) {
      if (who.deviceId.startsWith('browser:')) throw new ServiceError('device_required', 401);
      const installation = await s.accounts.installation(a.id);
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
        ].some((p) => path.endsWith(p))
      )
        throw new ServiceError('admission_closed', 503);
      return relay(request, `/${action.slice('runtime/'.length)}${url.search}`, {
        ...s,
        identity: who,
        account: a,
        installation,
      });
    }
    const stop = /^git-sessions\/([^/]+)\/stop$/.exec(action);
    if (method === 'POST' && stop) {
      const i = await s.accounts.installation(a.id);
      if (!i || request.headers.get('x-juiced-installation') !== i.id)
        throw new ServiceError('installation_changed', 409);
      await stopGitSession(s.platform, i, decodeURIComponent(stop[1]!), await jsonBody(request));
      return Response.json({ stopped: true });
    }
    return new Response('Not found', { status: 404 });
  }
  return async (request: Request) => {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      response = await dispatch(request);
    } catch (error) {
      const known = error instanceof ServiceError;
      if (!known || error.status >= 500)
        logError('request_failed', error, {
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
        });
      response = Response.json(
        { error: known ? error.code : 'service_unavailable' },
        {
          status: known ? error.status : 503,
          headers: {
            'X-Juiced-Error': '1',
            ...(known && error.status === 429 ? { 'Retry-After': '60' } : {}),
          },
        },
      );
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Request-ID', requestId);
    if (s.cfg.origin.startsWith('https:'))
      headers.set('Strict-Transport-Security', 'max-age=31536000');
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers,
    });
  };
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request, 16 * 1024);
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value as Record<string, unknown>;
  } catch {
    throw new ServiceError('invalid_request');
  }
}
