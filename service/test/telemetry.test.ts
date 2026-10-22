import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { Telemetry } from '../src/telemetry';
import { config } from '../src/config';
import { TELEMETRY_HEADER, readTelemetryContext, readCliEvent } from '../../contracts/telemetry';

const cfg = config({ NODE_ENV: 'test', JUICED_SERVICE_URL: 'https://juiced.example', JUICED_AUTH_SECRET: 'x'.repeat(32), JUICED_DATABASE_URL: 'postgres://unused' });
const context = { installationId: crypto.randomUUID(), anonymousId: crypto.randomUUID(), version: '0.2.4', platform: 'darwin', arch: 'arm64' };
const request = (body: unknown, authenticated = false) => new Request('https://juiced.example/v1/telemetry', {
  method: 'POST', headers: { 'Content-Type': 'application/json', [TELEMETRY_HEADER]: JSON.stringify(context), ...(authenticated ? { Authorization: `Bearer ${'a'.repeat(32)}` } : {}) },
  body: JSON.stringify(body),
});
function fixture(status = 200) {
  const batches: { api_key: string; batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] }[] = [];
  const queries: unknown[][] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    queries.push(values);
    return { rows: sql.includes('oauthAccessToken') ? [{ user_id: 'verified-user', device_id: 'device', expires_at: new Date(Date.now() + 60000), scopes: ['juiced'], resources: [cfg.origin] }] : [{ count: 1 }] };
  } } as unknown as Pool;
  const telemetry = new Telemetry({ JUICED_POSTHOG_KEY: 'phc_fixture', JUICED_POSTHOG_HOST: 'https://eu.i.posthog.com' }, async (url, init) => {
    assert.equal(String(url), 'https://eu.i.posthog.com/batch/');
    assert.equal(init?.redirect, 'error');
    batches.push(JSON.parse(String(init?.body)));
    return new Response(null, { status });
  });
  return { telemetry, batches, pool, queries };
}

test('no PostHog key disables collection without any database or network calls', async () => {
  const telemetry = new Telemetry({}, async () => { throw new Error('Unexpected network'); });
  assert.equal((await telemetry.receive(request({}), {} as Pool, cfg)).status, 204);
});

test('install events carry only approved properties and never forward request headers or IPs', async () => {
  const f = fixture();
  const input = request({ event: 'cli_installed', properties: { install_kind: 'fresh' } });
  input.headers.set('x-juiced-peer-ip', '192.0.2.1');
  input.headers.set('User-Agent', 'sensitive hostname');
  assert.equal((await f.telemetry.receive(input, f.pool, cfg)).status, 202);
  const event = f.batches[0]!.batch[0]!;
  assert.equal(event.distinct_id, `anonymous:${context.anonymousId}`);
  assert.equal(event.properties.installation_id, context.installationId);
  assert.equal(event.properties.$process_person_profile, false);
  assert.equal(event.properties.$geoip_disable, true);
  assert.doesNotMatch(JSON.stringify(f.batches), /192\.0\.2\.1|sensitive hostname|authorization/);
});

test('session activity requires authentication and links to the verified user', async () => {
  const f = fixture();
  const body = { event: 'cli_session_active', properties: { session_mode: 'interactive' } };
  await assert.rejects(f.telemetry.receive(request(body), f.pool, cfg), { code: 'not_signed_in' });
  assert.equal(f.batches.length, 0);
  assert.equal((await f.telemetry.receive(request(body, true), f.pool, cfg)).status, 202);
  const [identify, activity] = f.batches[0]!.batch;
  assert.equal(identify!.event, '$identify');
  assert.equal(identify!.properties.$anon_distinct_id, `anonymous:${context.anonymousId}`);
  assert.equal(activity!.distinct_id, 'user:verified-user');
  assert.equal(activity!.event, 'cli_session_active');
});

test('event allowlist rejects arbitrary content, user IDs, error strings and oversized bodies', async () => {
  const f = fixture();
  for (const body of [
    { event: 'cli_login_succeeded', properties: {} },
    { event: 'cli_first_run', properties: { prompt: 'secret' } },
    { event: 'cli_installed', properties: { install_kind: 'fresh' }, userId: 'someone-else' },
    { event: 'cli_session_active', properties: { session_mode: 'interactive', error: 'secret' } },
  ]) await assert.rejects(f.telemetry.receive(request(body, true), f.pool, cfg), { code: 'invalid_telemetry' });
  await assert.rejects(f.telemetry.receive(request({ event: 'cli_first_run', properties: { prompt: 'x'.repeat(2000) } }), f.pool, cfg), { code: 'request_too_large' });
  assert.equal(f.batches.length, 0);
  assert.equal(readTelemetryContext({ ...context, path: '/secret' }), undefined);
  assert.equal(readTelemetryContext({ ...context, version: 'secret prompt' }), undefined);
  assert.equal(readCliEvent({ event: 'cli_installed', properties: { install_kind: 'fresh', data: 'secret' } }), undefined);
});

test('rate limiting and unavailable PostHog do not acknowledge undelivered events', async () => {
  const f = fixture(503);
  const body = { event: 'cli_first_run', properties: {} };
  assert.equal((await f.telemetry.receive(request(body), f.pool, cfg)).status, 204);
  const pool = { query: async () => ({ rows: [{ count: 61 }] }) } as unknown as Pool;
  await assert.rejects(f.telemetry.receive(request(body), pool, cfg), { code: 'rate_limit_exceeded' });
  const broken = new Telemetry({ JUICED_POSTHOG_KEY: 'phc_fixture' }, async () => { throw new Error('offline'); });
  assert.equal(await broken.capture('cli_installed', context), false);
  assert.throws(() => new Telemetry({ JUICED_POSTHOG_KEY: 'phc_fixture', JUICED_POSTHOG_HOST: 'http://internal' }), /JUICED_POSTHOG_HOST/);
});
