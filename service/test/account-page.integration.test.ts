import { testDatabase } from './database';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSignature } from 'better-auth/crypto';
import { authentication } from '../src/auth';
import { Accounts } from '../src/accounts';
import { application } from '../src/app';
import { config } from '../src/config';
import type { Platform } from '../src/platform';

test(
  'the account console redirects signed-out visitors and shows the signed-in account',
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
      const auth = authentication(pool, cfg);
      const context = await auth.$context;
      const user = await context.internalAdapter.createUser(
        { name: 'Ada <Lovelace>', email: `${crypto.randomUUID()}@example.com`, emailVerified: true },
        { method: 'admin' },
      );
      await context.internalAdapter.linkAccount({
        userId: user.id,
        providerId: 'github',
        accountId: 'gh-1',
      });
      const session = await context.internalAdapter.createSession(user.id, false);
      const cookie = `better-auth.session_token=${encodeURIComponent(session.token + '.' + (await makeSignature(session.token, cfg.secret)))}`;
      const accounts = new Accounts(pool, {
        packageId: 'pkg_' + 'a'.repeat(32),
        runtimeId: 'runtime-v1',
        minimumCli: '0.2.0',
      });
      const platform = {} as Platform;
      const handle = application({ pool, cfg, accounts, platform, auth });
      const get = (headers: Record<string, string> = {}) =>
        handle(new Request(`${cfg.origin}/account`, { headers }));

      const signedOut = await get();
      assert.equal(signedOut.status, 302);
      assert.equal(signedOut.headers.get('location'), `${cfg.origin}/sign-in`);

      await pool.query(
        `INSERT INTO devices(id,user_id,label,expires_at) VALUES('dev_live',$1,'Work laptop',now()+interval '30 days'),
        ('dev_gone',$1,'Old laptop',now()+interval '30 days'),('dev_expired',$1,'Expired laptop',now()-interval '1 day')`,
        [user.id],
      );
      await pool.query(`UPDATE devices SET revoked_at=now() WHERE id='dev_gone'`);
      const response = await get({ Cookie: cookie });
      const html = await response.text();
      assert.equal(response.status, 200, html);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const account = await accounts.ensure(user.id);
      assert.ok(html.includes(account.id));
      assert.ok(html.includes(user.email));
      assert.ok(html.includes('Work laptop'));
      assert.ok(!html.includes('Old laptop') && !html.includes('Expired laptop'));
      assert.ok(!html.includes('Ada <Lovelace>'), 'user names are escaped');
      assert.match(html, /GitHub<\/div><span class="ok-text">Connected/);
      assert.match(html, /data-provider="google">Connect/);
      assert.ok(html.includes('Not created yet'));
      assert.ok(html.includes('CLI sign-ins'));
      assert.ok(html.includes('Sign out all CLI sessions'), 'bulk sign-out is available even with one CLI session');
      assert.ok(html.includes('Sign out of browser'));

      const otherUser = await context.internalAdapter.createUser(
        { name: 'Other user', email: `${crypto.randomUUID()}@example.com`, emailVerified: true },
        { method: 'admin' },
      );
      await pool.query(
        `INSERT INTO devices(id,user_id,label,expires_at) VALUES('dev_second',$1,'Second computer',now()+interval '30 days'),
        ('dev_foreign',$2,'Other account',now()+interval '30 days')`,
        [user.id, otherUser.id],
      );
      const logoutAll = await handle(new Request(`${cfg.origin}/v1/logout`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: cfg.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }));
      assert.equal(logoutAll.status, 200);
      const remaining = (await pool.query('SELECT id FROM devices WHERE revoked_at IS NULL AND expires_at>now()')).rows;
      assert.deepEqual(remaining.map((row) => row.id), ['dev_foreign']);
      const afterLogoutAll = await get({ Cookie: cookie });
      assert.equal(afterLogoutAll.status, 200, 'CLI sign-out keeps the browser signed in');
      assert.match(await afterLogoutAll.text(), /No CLI sessions are signed in/);

      await pool.query(`UPDATE accounts SET status='deleting' WHERE id=$1`, [account.id]);
      assert.ok((await (await get({ Cookie: cookie })).text()).includes('deletion is in progress'));

      await pool.query(
        `INSERT INTO devices(id,user_id,label,expires_at) VALUES('dev_keep',$1,'Still signed in',now()+interval '30 days')`,
        [user.id],
      );
      const logoutBrowser = await handle(new Request(`${cfg.origin}/api/auth/sign-out`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: cfg.origin, 'Content-Type': 'application/json' },
        body: '{}',
      }));
      assert.equal(logoutBrowser.status, 200, await logoutBrowser.text());
      const afterLogoutBrowser = await get({ Cookie: cookie });
      assert.equal(afterLogoutBrowser.status, 302);
      assert.equal(afterLogoutBrowser.headers.get('location'), `${cfg.origin}/sign-in`);
      assert.equal((await pool.query("SELECT revoked_at FROM devices WHERE id='dev_keep'")).rows[0]!.revoked_at, null);
    } finally {
      await fixture.close();
    }
  },
);
