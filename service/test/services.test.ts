import assert from 'node:assert/strict';
import test from 'node:test';
import { services } from '../src/services';

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
  JUICED_PACKAGE_ID: 'pkg_fixture',
  JUICED_RUNTIME_ID: 'fixture.v1',
  CANTELOP_API_URL: 'https://cantelop.example',
  CANTELOP_FLEET_ID: `flt_${'a'.repeat(32)}`,
  CANTELOP_FLEET_TOKEN: `fsp_${'b'.repeat(32)}.${'c'.repeat(64)}`,
  CANTELOP_WORKER_FLEET_TOKEN: `fsp_${'d'.repeat(32)}.${'e'.repeat(64)}`,
};

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
