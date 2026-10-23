import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { relay, boundedBody } from '../src/relay';
import { Platform } from '../src/platform';
import { CantelopClient } from '@cantelop/sdk';
import type { JuicedFleet } from '../src/platform';
import { Accounts, type Account, type Installation } from '../src/accounts';
import { config } from '../src/config';
import { application } from '../src/app';
import type { Auth } from '../src/auth';
const cfg = config({
  NODE_ENV: 'test',
  JUICED_SERVICE_URL: 'http://127.0.0.1:3000',
  JUICED_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
  JUICED_DATABASE_URL: 'postgresql://test@localhost/test',
});
const account: Account = {
  id: 'acc_' + 'a'.repeat(32),
  owner_user_id: 'user',
  status: 'active',
  entitlement: 'active',
  period_id: 'invoice',
  period_end: new Date(Date.now() + 86400000),
  included_credits: '1000000',
  created_at: new Date(),
};
const installation: Installation = {
  id: 'jin_' + 'a'.repeat(32),
  account_id: account.id,
  external_key: 'external-account-key',
  app_id: 'app_' + 'a'.repeat(32),
  platform_id: 'ins_' + 'a'.repeat(32),
  package_id: 'pkg_' + 'a'.repeat(32),
  runtime_id: 'runtime-v1',
  status: 'ready',
  error_code: null,
  policy_revision: 2,
  entitlement_epoch: 'invoice',
  desired_package_id: null,
  desired_runtime_id: null,
};
const envelope = (type: string) => ({
  protocolVersion: 2,
  id: 'msg_' + 'a'.repeat(32),
  workspace: { id: 'wsp_' + 'a'.repeat(32) },
  session: { id: 'ses_' + 'a'.repeat(32) },
  command: { type },
});
const request = (path: string, body: unknown) =>
  new Request('http://127.0.0.1:3000' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Juiced-Installation': installation.id,
      Authorization: 'Bearer client-device-token',
      'X-Cantelop-Session-Runtime': 'runtime-v1',
    },
    body: JSON.stringify(body),
  });
function context(platform: Platform) {
  return {
    pool: {} as Pool,
    cfg,
    account,
    installation,
    platform,
    identity: { userId: 'user', deviceId: 'dev_test', expiresAt: Date.now() + 300000 },
    accounts: { entitled: () => true } as unknown as Accounts,
  };
}
test('relay pins server App credentials and streams without buffering or losing cancellation', async t => {
  let upstreamRequest: Request | undefined,
    cancelled = false;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const previous = process.env.CANTELOP_APP_CONFIG;
  process.env.CANTELOP_APP_CONFIG = JSON.stringify({schemaVersion:1,activeProfile:'default',profiles:{default:{apps:[],fleets:[{name:'juiced',id:`flt_${'a'.repeat(32)}`,controlUrl:'https://platform.example',accessToken:`fsp_${'a'.repeat(32)}.${'b'.repeat(64)}`}]}}});
  t.after(() => { if (previous === undefined) delete process.env.CANTELOP_APP_CONFIG; else process.env.CANTELOP_APP_CONFIG = previous; });
  t.mock.method(globalThis,'fetch', async (r: Request) => {
    if (new URL(r.url).origin === 'https://platform.example') {
      if (r.url.endsWith('/credentials')) return Response.json({appId:installation.app_id!,runtimeId:'runtime-v1',edgeUrl:'https://tenant-a.example',accessToken:'server-app-token'});
      return Response.json({id:installation.platform_id,external_key:installation.external_key,app_id:installation.app_id,package_id:installation.package_id,runtime_id:'runtime-v1',status:'ready',version:'1.0.0',policy_revision:2,enforced_revision:2});
    }
    upstreamRequest = r;
    return new Response(new ReadableStream<Uint8Array>({start(c) {source=c;c.enqueue(new TextEncoder().encode('data: first\n\n'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  });
  const platform = new Platform(new CantelopClient().fleet({name:'juiced',runtime:{receive(){},[Symbol.for('dev.cantelop.sdk.compiled-runtime.v1')]:'runtime-v1'}}) as JuicedFleet);
  const input = request('/commands/stream', envelope('stream'));
  input.headers.set('Authorization', 'Bearer ' + 'x'.repeat(40));
  input.headers.set('X-Juiced-Timing', '1');
  const ctx = context(platform);
  const response = await application({ ...ctx, auth: {} as Auth,
    pool: { async query(sql: string) {
      if (sql.includes('"oauthAccessToken"')) return { rows: [{ user_id: 'user', device_id: 'dev_test', expires_at: new Date(Date.now() + 300000), scopes: ['juiced'], resources: [cfg.origin] }] };
      if (sql.includes('api_limits')) return { rows: [{ count: 1 }] };
      assert.fail('Unexpected database operation');
    } } as unknown as Pool,
    accounts: { entitled: () => true, async authorize() { return account; }, async installation() { return installation; } } as unknown as Accounts,
  })(new Request('http://127.0.0.1:3000/v1/accounts/' + account.id + '/runtime/commands/stream', input));
  const timing = response.headers.get('server-timing')!;
  for (const phase of ['auth', 'rate_limit', 'account', 'installation', 'fleet_connection', 'edge', 'service_total']) assert.match(timing, new RegExp(`${phase};dur=\\d+\\.\\d`));
  assert.doesNotMatch(timing, /Bearer|client-device-token|server-app-token|tenant-a|SELECT/);
  assert.equal(upstreamRequest!.headers.get('authorization'), 'Bearer server-app-token');
  assert.equal(new URL(upstreamRequest!.url).origin, 'https://tenant-a.example');
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  source.enqueue(new TextEncoder().encode('data: later\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: later\n\n');
  await reader.cancel();
  assert.equal(cancelled, true);
});
test('relay rejects raw database, arbitrary paths, changed pins and protocol/path mismatches before upstream', async () => {
  let called = false;
  const platform = {
    connection: async () => {
      called = true;
      throw new Error('unexpected');
    },
  } as unknown as Platform;
  for (const [path, body, code] of [
    [
      '/commands/workspace.database',
      { ...envelope('workspace.database'), session: null },
      'database_credentials_unavailable',
    ],
    ['/private/admin', envelope('stop'), 'not_found'],
    ['/commands/view', envelope('stop'), 'invalid_runtime_request'],
  ] as const)
    await assert.rejects(relay(request(path, body), path, context(platform)), { code });
  const wrong = request('/commands/stop', envelope('stop'));
  wrong.headers.set('x-juiced-installation', 'different');
  await assert.rejects(relay(wrong, '/commands/stop', context(platform)), {
    code: 'installation_changed',
  });
  assert.equal(called, false);
});
test('bounded upload rejects incremental oversize without buffering an unbounded body', async () => {
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8));
      c.enqueue(new Uint8Array(8));
      c.close();
    },
  });
  const reader = boundedBody(input, 10)!.getReader();
  assert.equal((await reader.read()).value!.length, 8);
  await assert.rejects(reader.read(), { code: 'request_too_large' });
});

test('slow relay authorization never overlaps and a sustained stall cancels the stream', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let checks = 0, authorized = 0, cancelled = false;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const platform = { async connection() { return { async fetch() {
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  } }; } } as unknown as Platform;
  const ctx = context(platform);
  ctx.pool = { async query() { checks++; await waiting; return { rowCount: 1 }; } } as unknown as Pool;
  ctx.accounts = { async authorize() { authorized++; return account; }, async installation() { return installation; } } as unknown as Accounts;
  const response = await relay(request('/commands/stream', envelope('stream')), '/commands/stream', ctx);
  t.mock.timers.tick(5000);
  assert.equal(checks, 1);
  t.mock.timers.tick(5000);
  assert.equal(checks, 1, 'The next interval cannot start another check while the first is pending');
  assert.equal(cancelled, false, 'A briefly slow check keeps the stream open');
  t.mock.timers.tick(25000);
  assert.equal(checks, 1);
  assert.equal(cancelled, true);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(authorized, 0, 'A timed-out check stops before its next database query');
  t.mock.timers.tick(15000);
  assert.equal(checks, 1);
  await response.body!.cancel();
});

test('healthy relay checks continue and a revoked device stops later checks', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let checks = 0, installations = 0, active = true, cancelled = false;
  const platform = { async connection() { return { async fetch() {
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  } }; } } as unknown as Platform;
  const ctx = context(platform);
  ctx.pool = { async query() { checks++; return { rowCount: active ? 1 : 0 }; } } as unknown as Pool;
  ctx.accounts = { async authorize() { return account; }, async installation() { installations++; return installation; } } as unknown as Accounts;
  const response = await relay(request('/commands/stream', envelope('stream')), '/commands/stream', ctx);
  t.mock.timers.tick(5000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(installations, 1);
  t.mock.timers.tick(5000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(installations, 2);
  active = false;
  t.mock.timers.tick(5000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  t.mock.timers.tick(15000);
  assert.equal(checks, 3);
  assert.equal(installations, 2);
  await response.body!.cancel();
});
