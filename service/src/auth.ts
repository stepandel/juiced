import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import {
  oauthProvider,
  oauthDeviceAuthorization,
  DEVICE_CODE_GRANT_TYPE,
} from '@better-auth/oauth-provider';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from './config';
import { ServiceError, readText } from './config';
import { transaction } from './db';
import type { Telemetry } from './telemetry';
import { telemetryFromHeaders } from '../../contracts/telemetry';

export const CLIENT_ID = 'juiced-cli';
export const tokenHash = (token: string, type: string) =>
  createHash('sha256').update(`${type}\0${token}`).digest('hex');
export function authOptions(pool: Pool, cfg: Config, setup = false) {
  return {
    baseURL: cfg.origin,
    secret: cfg.secret,
    database: pool,
    appName: 'Juiced',
    trustedOrigins: [cfg.origin],
    emailAndPassword: { enabled: false },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        trustedProviders: [],
      },
    },
    socialProviders: {
      ...(cfg.githubId && cfg.githubSecret
        ? {
            github: {
              clientId: cfg.githubId,
              clientSecret: cfg.githubSecret,
              scope: ['read:user', 'user:email'],
            },
          }
        : {}),
      ...(cfg.googleId && cfg.googleSecret
        ? { google: { clientId: cfg.googleId, clientSecret: cfg.googleSecret } }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!user.emailVerified)
              throw new APIError('FORBIDDEN', { message: 'A verified email is required' });
            return { data: user };
          },
        },
      },
    },
    session: { expiresIn: 30 * 86400, cookieCache: { enabled: false } },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-juiced-peer-ip'] },
      database: { generateId: () => randomUUID() },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100 },
    plugins: [
      oauthProvider({
        disableJwtPlugin: true,
        scopes: ['juiced', 'offline_access'],
        resources: [
          {
            identifier: cfg.origin,
            allowedScopes: ['juiced', 'offline_access'],
            accessTokenTtl: 300,
          },
        ],
        // The provider requires authorization_code at server level for refresh support;
        // the registered public CLI is restricted to device_code and refresh_token.
        grantTypes: ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT_TYPE],
        loginPage: '/sign-in',
        consentPage: '/device',
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 30 * 86400,
        refreshTokenReuseInterval: 10,
        allowDynamicClientRegistration: false,
        clientPrivileges: async () => setup,
        resourcePrivileges: async () => setup,
        generateClientId: () => CLIENT_ID,
        storeTokens: { hash: async (token, type) => tokenHash(token, type) },
      }),
      oauthDeviceAuthorization({ verificationUri: '/device', expiresIn: '10m', interval: '5s' }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/device/code' && ctx.body?.client_id !== CLIENT_ID)
          throw new APIError('BAD_REQUEST', { message: 'Unknown CLI client' });
      }),
    },
  } satisfies BetterAuthOptions;
}
export function authentication(pool: Pool, cfg: Config, setup = false) {
  return betterAuth(authOptions(pool, cfg, setup));
}
export type Auth = ReturnType<typeof authentication>;

/** Operator-only setup; never mounted as a public administrative endpoint. */
export async function seedClient(auth: Auth, pool: Pool, cfg: Config) {
  const context = await auth.$context;
  if (!(await pool.query('SELECT 1 FROM "oauthClient" WHERE "clientId"=$1', [CLIENT_ID])).rowCount)
    await context.adapter.create({
      model: 'oauthClient',
      data: {
        clientId: CLIENT_ID,
        name: 'Juiced CLI',
        applicationType: 'native',
        tokenEndpointAuthMethod: 'none',
        grantTypes: [DEVICE_CODE_GRANT_TYPE, 'refresh_token'],
        scopes: ['juiced', 'offline_access'],
        redirectUris: [],
        disabled: false,
      },
    });
  // The provider's resource relationship uses the public identifier as its key.
  if (
    !(await pool.query('SELECT 1 FROM "oauthResource" WHERE identifier=$1', [cfg.origin])).rowCount
  )
    await context.adapter.create({
      model: 'oauthResource',
      data: {
        identifier: cfg.origin,
        name: 'Juiced API',
        allowedScopes: ['juiced', 'offline_access'],
        accessTokenTtl: 300,
        refreshTokenTtl: 30 * 86400,
        disabled: false,
        policyVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  await pool.query(
    'INSERT INTO "oauthClientResource"(id,"clientId","resourceId","createdAt") VALUES($1,$2,$3,now()) ON CONFLICT DO NOTHING',
    [randomUUID(), CLIENT_ID, cfg.origin],
  );
}

/** Provider issues/rotates opaque tokens; this records their device lineage before returning them. */
export async function authHandler(auth: Auth, pool: Pool, request: Request, telemetry?: Telemetry) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/auth/oauth2/token' || request.method !== 'POST') return auth.handler(request);
  const raw = await readText(request.clone(), 16 * 1024);
  let data: URLSearchParams;
  try {
    data = request.headers.get('Content-Type')?.startsWith('application/json')
      ? new URLSearchParams(JSON.parse(raw) as Record<string, string>)
      : new URLSearchParams(raw);
  } catch {
    throw new ServiceError('invalid_request');
  }
  if (data.get('client_id') !== CLIENT_ID) throw new ServiceError('invalid_client', 401);
  const refresh = data.get('refresh_token');
  let device: string | undefined;
  if (refresh) {
    const old = await pool.query(
      `SELECT d.id FROM "oauthRefreshToken" r JOIN device_refresh_tokens m ON m.refresh_id=r.id
      JOIN devices d ON d.id=m.device_id WHERE r.token=$1 AND d.revoked_at IS NULL AND d.expires_at>now()`,
      [tokenHash(refresh, 'refresh_token')],
    );
    if (!old.rows[0]) throw new ServiceError('device_revoked', 401);
    device = old.rows[0].id;
  }
  const response = await auth.handler(request);
  if (!response.ok) return response;
  const tokens = (await response.clone().json()) as { refresh_token?: string };
  if (!tokens.refresh_token) throw new ServiceError('device_grant_missing', 503);
  const userId = await transaction(pool, async (tx) => {
    const refreshRow = (
      await tx.query(`SELECT id,"userId" FROM "oauthRefreshToken" WHERE token=$1`, [
        tokenHash(tokens.refresh_token!, 'refresh_token'),
      ])
    ).rows[0];
    if (!refreshRow) throw new ServiceError('device_grant_missing', 503);
    const mapped = (
      await tx.query('SELECT device_id FROM device_refresh_tokens WHERE refresh_id=$1', [
        refreshRow.id,
      ])
    ).rows[0];
    device ??= mapped?.device_id;
    if (device) {
      const live = await tx.query(
        'SELECT id FROM devices WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',
        [device, refreshRow.userId],
      );
      if (!live.rowCount) throw new ServiceError('device_revoked', 401);
    } else {
      device = `dev_${randomUUID().replaceAll('-', '')}`;
      await tx.query(
        `INSERT INTO devices(id,user_id,label,expires_at) VALUES($1,$2,$3,now()+interval '30 days')`,
        [
          device,
          refreshRow.userId,
          (request.headers.get('x-juiced-device-name') ?? 'Juiced CLI')
            .replace(/[^A-Za-z0-9 ._-]/g, '')
            .slice(0, 64) || 'Juiced CLI',
        ],
      );
      await tx.query("INSERT INTO audit(actor,action,target) VALUES($1,'device.login',$2)", [
        refreshRow.userId,
        device,
      ]);
    }
    await tx.query(
      'INSERT INTO device_refresh_tokens(refresh_id,device_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [refreshRow.id, device],
    );
    return String(refreshRow.userId);
  });
  // Only completed device grants are logins; token refreshes are not new users.
  const context = telemetryFromHeaders(request.headers);
  if (!refresh && data.get('grant_type') === DEVICE_CODE_GRANT_TYPE && context)
    // Analytics must not delay the sign-in response.
    void telemetry?.capture('cli_login_succeeded', context, {}, userId).catch(() => {});
  return response;
}

export interface Identity {
  userId: string;
  deviceId: string;
  expiresAt: number;
}
/** Opaque access tokens are looked up in the issuer's own DB on every authorization. */
export async function authenticate(pool: Pool, cfg: Config, request: Request): Promise<Identity> {
  const match = /^Bearer ([A-Za-z0-9_-]{20,512})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new ServiceError('not_signed_in', 401);
  const row = (
    await pool.query(
      `SELECT a."userId" AS user_id,a."expiresAt" AS expires_at,a.scopes,a.resources,d.id AS device_id
    FROM "oauthAccessToken" a JOIN device_refresh_tokens m ON m.refresh_id=a."refreshId" JOIN devices d ON d.id=m.device_id
    JOIN "user" u ON u.id=a."userId" WHERE a.token=$1 AND a."clientId"=$2 AND a."expiresAt">now() AND a.revoked IS NULL
    AND d.user_id=a."userId" AND d.revoked_at IS NULL AND d.expires_at>now()`,
      [tokenHash(match[1]!, 'access_token'), CLIENT_ID],
    )
  ).rows[0];
  if (!row || !list(row.scopes).includes('juiced') || !list(row.resources).includes(cfg.origin))
    throw new ServiceError('not_signed_in', 401);
  return {
    userId: row.user_id,
    deviceId: row.device_id,
    expiresAt: new Date(row.expires_at).getTime(),
  };
}
/** Streams outlive the 300s access token that opened them; they end when the device does. */
export async function deviceActive(pool: Pool, identity: Identity) {
  return Boolean(
    (
      await pool.query(
        `SELECT 1 FROM devices d JOIN "user" u ON u.id=d.user_id
    WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.expires_at>now()`,
        [identity.deviceId, identity.userId],
      )
    ).rowCount,
  );
}
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  try {
    return JSON.parse(String(value)) as string[];
  } catch {
    return [];
  }
}
