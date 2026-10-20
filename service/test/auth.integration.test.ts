import { testDatabase, user as createVerifiedUser } from './database.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSignature } from 'better-auth/crypto';
import { database, migrate } from '../src/db.js';
import { authentication, seedClient, authenticate, CLIENT_ID } from '../src/auth.js';
import { Accounts } from '../src/accounts.js';
import { application } from '../src/app.js';
import { config } from '../src/config.js';
import type { Platform } from '../src/platform.js';

test(
  'real device approval, rotating refresh, account isolation and revocation',
  { skip: !process.env.JUICED_TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const cfg = config({
      NODE_ENV: 'test',
      JUICED_SERVICE_URL: 'http://127.0.0.1:3000',
      JUICED_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
      JUICED_DATABASE_URL: process.env.JUICED_TEST_DATABASE_URL,
    });
    const fixture = await testDatabase(),
      pool = fixture.pool;
    try {
      await migrate(pool);
      const auth = authentication(pool, cfg);
      await seedClient(auth, pool, cfg);
      const context = await auth.$context;
      const user = await context.internalAdapter.createUser(
        { name: 'Device test', email: `${crypto.randomUUID()}@example.com`, emailVerified: true },
        { method: 'admin' },
      );
      const session = await context.internalAdapter.createSession(user.id, false);
      const cookie = `better-auth.session_token=${encodeURIComponent(session.token + '.' + (await makeSignature(session.token, cfg.secret)))}`;
      const accounts = new Accounts(pool, {
        packageId: 'pkg_' + 'a'.repeat(32),
        runtimeId: 'runtime-v1',
        minimumCli: '0.2.0',
      });
      const platform = {
        credentials() {
          throw new Error('No upstream call permitted');
        },
      } as unknown as Platform;
      const { app } = application({ pool, cfg, accounts, platform, auth });
      const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        app.request(`${cfg.origin}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: cfg.origin, ...headers },
          body: JSON.stringify(body),
        });
      const started = await json('/api/auth/device/code', {
        client_id: CLIENT_ID,
        scope: 'juiced offline_access',
        resource: cfg.origin,
      });
      const code = (await started.json()) as { device_code: string; user_code: string };
      assert.equal(started.status, 200, JSON.stringify(code));
      const claimed = await app.request(
        `${cfg.origin}/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(claimed.status, 200, await claimed.text());
      const approved = await json(
        '/api/auth/device/approve',
        { userCode: code.user_code },
        { Cookie: cookie },
      );
      assert.equal(approved.status, 200, await approved.text());
      const token = await app.request(`${cfg.origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: code.device_code,
        }),
      });
      const tokens = (await token.json()) as { access_token: string; refresh_token: string };
      assert.equal(token.status, 200, JSON.stringify(tokens));
      const headers = { Authorization: `Bearer ${tokens.access_token}` };
      const who = await authenticate(pool, cfg, new Request(cfg.origin, { headers }));
      assert.equal(who.userId, user.id);
      const me = await app.request(`${cfg.origin}/v1/me`, { headers });
      assert.equal(me.status, 200);
      const account = await accounts.ensure(user.id);
      const blocked = await json(
        `/v1/accounts/${account.id}/bootstrap`,
        { version: '0.2.0', runtimeId: 'runtime-v1' },
        headers,
      );
      assert.equal(blocked.status, 403);
      await pool.query(
        `UPDATE accounts SET entitlement='active',period_id='test-period',period_end=now()+interval '1 day',included_credits=1000000 WHERE id=$1`,
        [account.id],
      );
      const boot = await Promise.all(
        Array.from({ length: 6 }, () =>
          json(
            `/v1/accounts/${account.id}/bootstrap`,
            { version: '0.2.0', runtimeId: 'runtime-v1' },
            headers,
          ),
        ),
      );
      assert.ok(boot.every((r) => r.status === 200));
      const states = (await Promise.all(boot.map((r) => r.json()))) as { id: string }[];
      assert.equal(new Set(states.map((x) => x.id)).size, 1);
      const foreign = await accounts.ensure(await createVerifiedUser(pool));
      assert.equal(
        (await app.request(`${cfg.origin}/v1/accounts/${foreign.id}/installation`, { headers }))
          .status,
        404,
      );
      await pool.query(
        `UPDATE installations SET status='ready',platform_id=$2,app_id=$3 WHERE account_id=$1`,
        [
          account.id,
          'ins_' + crypto.randomUUID().replaceAll('-', ''),
          'app_' + crypto.randomUUID().replaceAll('-', ''),
        ],
      );
      const denied = await json(
        `/v1/accounts/${account.id}/runtime/commands/workspace.database`,
        {
          protocolVersion: 2,
          id: 'msg_' + 'a'.repeat(32),
          workspace: { slug: 'project' },
          session: null,
          command: { type: 'workspace.database' },
        },
        { ...headers, 'X-Juiced-Installation': states[0]!.id },
      );
      assert.equal(denied.status, 403);
      // Refresh uses the provider's standard form endpoint and the same device lineage.
      const refreshed = await app.request(`${cfg.origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: tokens.refresh_token,
        }),
      });
      const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
      assert.equal(refreshed.status, 200, JSON.stringify(next));
      const renewed = await authenticate(
        pool,
        cfg,
        new Request(cfg.origin, { headers: { Authorization: `Bearer ${next.access_token}` } }),
      );
      assert.equal(renewed.deviceId, who.deviceId);
      const revoked = await app.request(`${cfg.origin}/v1/devices/${who.deviceId}`, {
        method: 'DELETE',
        headers,
      });
      assert.equal(revoked.status, 200);
      await assert.rejects(
        authenticate(
          pool,
          cfg,
          new Request(cfg.origin, { headers: { Authorization: `Bearer ${next.access_token}` } }),
        ),
        { code: 'not_signed_in' },
      );
      const retry = await app.request(`${cfg.origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: next.refresh_token,
        }),
      });
      assert.equal(retry.status, 401);
    } finally {
      await fixture.close();
    }
  },
);
