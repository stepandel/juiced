import { fleet } from '../.cantelop/client/client.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { services } from '../src/services';
import { application } from '../src/app';
import type { Auth } from '../src/auth';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JUICED_SERVICE_URL: 'https://juiced.example',
  JUICED_AUTH_SECRET: 'x'.repeat(32),
  JUICED_DATABASE_URL: 'postgres://api@127.0.0.1:5432/juiced',
  JUICED_WORKER_DATABASE_URL: 'postgres://worker@127.0.0.1:5432/juiced',
  JUICED_GITHUB_CLIENT_ID: 'github-id',
  JUICED_GITHUB_CLIENT_SECRET: 'github-secret',
  JUICED_GOOGLE_CLIENT_ID: 'google-id',
  JUICED_GOOGLE_CLIENT_SECRET: 'google-secret',
  CANTELOP_APP_CONFIG: JSON.stringify({schemaVersion: 1, activeProfile: 'api', profiles: Object.fromEntries(['api','worker'].map((profile,index) => [profile,{apps:[],fleets:[{name:'juiced',id:`flt_${'a'.repeat(32)}`,controlUrl:'https://cantelop.example',accessToken:`fsp_${'b'.repeat(32)}.${String(index+1).repeat(64)}`,packageId:`pkg_${'a'.repeat(32)}`,runtimeId:fleet.runtimeId}]}]))}),
};
// The Fleet SDK reads its integration document from the process environment.
process.env.CANTELOP_APP_CONFIG = base.CANTELOP_APP_CONFIG;

for (const role of ['api', 'worker'] as const)
  test(`${role} services start without Stripe and disable billing`, async () => {
    const s = services({ ...base }, role);
    try {
      assert.equal(s.billing, undefined);
    } finally {
      await s.pool.end();
    }
  });

test('a partial Stripe configuration is rejected', () => {
  assert.throws(
    () => services({ ...base, STRIPE_SECRET_KEY: 'sk_test_fixture' }),
    /STRIPE_PRICE_ID is required/,
  );
});

test('public configuration advertises the CLI paired with the deployed service', async () => {
  const s = services({ ...base, JUICED_CLI_VERSION: '0.2.2', JUICED_MINIMUM_CLI: '0.2.1' });
  try {
    const response = await application({ ...s, auth: {} as Auth })(new Request('https://juiced.example/v1/config'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).cliVersion, '0.2.2');
  } finally {
    await s.pool.end();
  }
  for (const cliVersion of ['invalid', '0.2.0'])
    assert.throws(() => services({ ...base, JUICED_CLI_VERSION: cliVersion, JUICED_MINIMUM_CLI: '0.2.1' }), /JUICED_CLI_VERSION/);
});

test('service startup requires CLI deployment metadata matching the compiled Fleet contract', () => {
  const start = (value: string) => {
    process.env.CANTELOP_APP_CONFIG = value;
    try { return services({...base,CANTELOP_APP_CONFIG:value}); } finally { process.env.CANTELOP_APP_CONFIG = base.CANTELOP_APP_CONFIG; }
  };
  for (const value of ['', '{invalid', JSON.stringify({schemaVersion:1,profiles:{api:{apps:[],fleets:[]}}})])
    assert.throws(() => start(value), /Fleet integration document|Fleet profile/);
  const document = JSON.parse(base.CANTELOP_APP_CONFIG!);
  document.profiles.api.fleets[0].runtimeId = 'runtime-other';
  assert.throws(() => start(JSON.stringify(document)), /matching the compiled Juiced runtime/);
  assert.throws(() => services({...base,CANTELOP_APP_CONFIG:JSON.stringify(document)}), /process environment the Fleet SDK reads/);
});
