import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CliTelemetry } from '../src/telemetry.js';
import { AccountClient } from '../src/account/client.js';
import { parseInvocation } from '../src/account/invocation.js';
import { TELEMETRY_HEADER } from '../contracts/telemetry.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'juiced-telemetry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  let output = '';
  const env = { JUICED_CONFIG_HOME: root, JUICED_SERVICE_URL: 'https://juiced.example' };
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 202 });
  };
  const telemetry = new CliTelemetry(env, fetcher, { write: (s: string | Uint8Array) => { output += s; return true; } });
  return { root, env, requests, fetcher, telemetry, output: () => output };
}

test('fresh installs and updates keep one installation ID; logout rotates only the anonymous identity', async t => {
  const f = await fixture(t);
  await f.telemetry.capture(f.env.JUICED_SERVICE_URL, 'cli_installed', { install_kind: 'fresh' });
  const initial = JSON.parse(f.requests[0]!.headers.get(TELEMETRY_HEADER)!);
  await f.telemetry.capture(f.env.JUICED_SERVICE_URL, 'cli_installed', { install_kind: 'update' });
  assert.deepEqual(JSON.parse(f.requests[1]!.headers.get(TELEMETRY_HEADER)!), initial);
  assert.equal(f.output().match(/Juiced collects/g)?.length, 1);
  await f.telemetry.resetIdentity();
  const next = JSON.parse((await f.telemetry.headers())[TELEMETRY_HEADER]!);
  assert.equal(next.installationId, initial.installationId);
  assert.notEqual(next.anonymousId, initial.anonymousId);
  assert.deepEqual(Object.keys(next).sort(), ['anonymousId', 'arch', 'installationId', 'platform', 'version']);
});

test('first run is recorded once across concurrent CLI instances and survives updates', async t => {
  const f = await fixture(t);
  const other = new CliTelemetry(f.env, f.fetcher, { write: () => true });
  f.telemetry.firstRun(f.env.JUICED_SERVICE_URL);
  other.firstRun(f.env.JUICED_SERVICE_URL);
  await Promise.all([f.telemetry.flush(), other.flush()]);
  const upgraded = new CliTelemetry(f.env, f.fetcher);
  upgraded.firstRun(f.env.JUICED_SERVICE_URL);
  await upgraded.flush();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.body, { event: 'cli_first_run', properties: {} });
});

test('disabled collection is not acknowledged as a recorded first run', async t => {
  const f = await fixture(t);
  const disabled = new CliTelemetry(f.env, async () => new Response(null, { status: 204 }), { write: () => true });
  disabled.firstRun(f.env.JUICED_SERVICE_URL);
  await disabled.flush();
  assert.equal(JSON.parse(await readFile(disabled.path, 'utf8')).firstRunSent, undefined);
  f.telemetry.firstRun(f.env.JUICED_SERVICE_URL);
  await f.telemetry.flush();
  assert.equal(f.requests.length, 1);
});

test('environment opt-outs and CI perform no telemetry IO', async t => {
  const f = await fixture(t);
  for (const override of [{ JUICED_TELEMETRY_DISABLED: '1' }, { DO_NOT_TRACK: '1' }, { CI: 'true' }]) {
    const client = new CliTelemetry({ ...f.env, ...override }, f.fetcher, { write: () => { throw new Error('Unexpected notice'); } });
    assert.deepEqual(await client.headers(), {});
    await client.capture(f.env.JUICED_SERVICE_URL, 'cli_installed', { install_kind: 'fresh' });
    client.firstRun(f.env.JUICED_SERVICE_URL);
    await client.flush();
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.telemetry.path), { code: 'ENOENT' });
});

test('persistent opt-out works offline and overrides all later CLI instances', async t => {
  const f = await fixture(t);
  await f.telemetry.preference(false);
  const client = new CliTelemetry(f.env, f.fetcher);
  assert.equal(await client.enabled(), false);
  assert.deepEqual(await client.headers(), {});
  assert.equal(await client.capture(f.env.JUICED_SERVICE_URL, 'cli_first_run'), false);
  await client.preference(true);
  assert.equal(await client.enabled(), true);
  const { anonymousId } = JSON.parse(await readFile(client.path, 'utf8'));
  await client.preference(true);
  assert.equal(JSON.parse(await readFile(client.path, 'utf8')).anonymousId, anonymousId, 'Enabling twice keeps the identity');
  assert.equal(parseInvocation(['telemetry', 'disable']).telemetryAction, 'disable');
  assert.equal(parseInvocation(['telemetry']).telemetryAction, 'status');
  assert.throws(() => parseInvocation(['telemetry', 'invalid']), /Usage/);
});

test('corrupt settings and failed HTTP requests cannot interrupt CLI operations', async t => {
  const f = await fixture(t);
  await writeFile(f.telemetry.path, '{invalid');
  assert.deepEqual(await f.telemetry.headers(), {});
  assert.equal(await f.telemetry.capture(f.env.JUICED_SERVICE_URL, 'cli_first_run'), false);
  assert.equal(await f.telemetry.enabled(), false);
  await f.telemetry.preference(false);
  assert.equal(JSON.parse(await readFile(f.telemetry.path, 'utf8')).disabled, true);
  await rm(f.telemetry.path);
  const unavailable = new CliTelemetry(f.env, async () => { throw new Error('offline'); }, { write: () => true });
  assert.equal(await unavailable.capture(f.env.JUICED_SERVICE_URL, 'cli_first_run'), false);
  unavailable.firstRun(f.env.JUICED_SERVICE_URL);
  await unavailable.flush();
  assert.equal(JSON.parse(await readFile(unavailable.path, 'utf8')).firstRunSent, undefined);
});

test('session events use account credentials and omit metadata after opt-out', async t => {
  const f = await fixture(t);
  const client = new AccountClient(f.env, f.fetcher, f.telemetry);
  await client.store.write({ origin: client.origin, accessToken: 'a'.repeat(32), refreshToken: 'b'.repeat(32), expiresAt: Date.now() + 60000 });
  client.track('cli_session_connected', { session_mode: 'interactive' });
  await f.telemetry.flush();
  assert.equal(f.requests[0]!.headers.get('authorization'), `Bearer ${'a'.repeat(32)}`);
  await f.telemetry.preference(false);
  await client.response('/v1/me', { method: 'GET' }, AbortSignal.timeout(1000));
  assert.equal(f.requests[1]!.headers.has(TELEMETRY_HEADER), false);
  client.track('cli_session_active', { session_mode: 'interactive' });
  await f.telemetry.flush();
  assert.equal(f.requests.length, 2);
  await f.telemetry.preference(true);
  await client.store.write({ origin: client.origin, accessToken: 'a'.repeat(32), refreshToken: 'b'.repeat(32), expiresAt: Date.now() + 1000 });
  client.track('cli_session_active', { session_mode: 'interactive' });
  await f.telemetry.flush();
  assert.equal(f.requests.length, 2, 'Background events never refresh credentials');
});
