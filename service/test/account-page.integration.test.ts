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

      await pool.query(`UPDATE accounts SET status='deleting' WHERE id=$1`, [account.id]);
      assert.ok((await (await get({ Cookie: cookie })).text()).includes('deletion is in progress'));
    } finally {
      await fixture.close();
    }
  },
);
