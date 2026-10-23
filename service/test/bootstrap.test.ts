import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { application } from '../src/app';
import type { Accounts } from '../src/accounts';
import type { Auth } from '../src/auth';
import type { Platform } from '../src/platform';
import { config } from '../src/config';

test('bootstrap carries the approved CLI release and wakes only installations with queued work', async () => {
  const cfg = config({ NODE_ENV: 'test', JUICED_SERVICE_URL: 'http://127.0.0.1:3000',
    JUICED_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters', JUICED_DATABASE_URL: 'postgresql://test@localhost/test' });
  const account = `acc_${'a'.repeat(32)}`;
  for (const [status, workQueued] of [['ready', false], ['ready', true], ['provisioning', true], ['upgrading', true]] as const) {
    let wakes = 0;
    const installation = { id: `jin_${'a'.repeat(32)}`, status, runtimeId: 'runtime', minimumCli: '0.3.1', error: null, operationId: 'test' };
    const app = application({ cfg, auth: {} as Auth, platform: {} as Platform,
      pool: { async query(sql: string) {
        if (sql.includes('"oauthAccessToken"')) return { rows: [{ user_id: 'user', device_id: 'device', expires_at: new Date(Date.now() + 300000), scopes: ['juiced'], resources: [cfg.origin] }] };
        if (sql.includes('api_limits')) return { rows: [{ count: 1 }] };
        assert.fail('Unexpected database operation');
      } } as unknown as Pool,
      accounts: { release: { cliVersion: '0.3.2' }, async authorize() { return { id: account }; }, async bootstrap() { return { ...installation, workQueued }; } } as unknown as Accounts,
      async wake() { wakes++; },
    });
    const response = await app(new Request(`${cfg.origin}/v1/accounts/${account}/bootstrap`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + 'x'.repeat(40), 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '0.3.2', runtimeId: 'runtime' }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...installation, cliVersion: '0.3.2' });
    assert.equal(wakes, workQueued ? 1 : 0);
  }
});
