import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseInvocation } from '../src/account/invocation.js';
import { CredentialStore } from '../src/account/store.js';
import { AccountClient, ManagedError } from '../src/account/client.js';
import { readInstallation } from '../contracts/account.js';

test('installation responses carry prerelease minimums through the shared CLI/service contract', () => {
  const installation = {
    id: 'jin_' + 'a'.repeat(32), status: 'ready', runtimeId: 'runtime-1',
    minimumCli: '0.2.0-rc.2', error: null, operationId: 'provision:test',
  };
  assert.deepEqual(readInstallation(installation), installation);
  assert.equal(readInstallation({ ...installation, minimumCli: '0.2.0' }).minimumCli, '0.2.0');
  for (const minimumCli of ['0.2.0-rc.01', '0.2.0\n', 'not-a-version', '0.2.0-' + 'a'.repeat(128)])
    assert.throws(() => readInstallation({ ...installation, minimumCli }), /Invalid Juiced installation/);
});

test('managed invocation defaults explicitly and separates account selectors from Claude prompts', () => {
  assert.deepEqual(parseInvocation(['claude', '--', 'login'], {}), {
    mode: 'managed',
    args: ['claude', '--', 'login'],
  });
  assert.equal(parseInvocation(['--self-managed', 'claude'], {}).mode, 'self-managed');
  assert.equal(parseInvocation(['login', '--no-browser'], {}).command, 'login');
  assert.equal(parseInvocation(['update'], {}).command, 'update');
  assert.equal(parseInvocation(['--self-managed', 'update'], {}).command, 'update');
  assert.throws(() => parseInvocation(['update', '--all'], {}), /Usage: juiced update/);
  assert.throws(() =>
    parseInvocation(['--self-managed', '--account', 'acc_' + 'a'.repeat(32), 'claude'], {}),
  );
  assert.throws(() => parseInvocation(['claude'], { JUICED_MODE: 'other' }));
  assert.throws(() => parseInvocation(['login', '--all'], {}));
});

test('required CLI updates explain the incompatibility and give an update command', () => {
  assert.match(new ManagedError('cli_upgrade_required').message, /incompatible[\s\S]*juiced update[\s\S]*curl -fsSL/);
});

test('credentials are private, origin scoped and serialize refresh across concurrent calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-credentials-'));
  try {
    const env = {
      JUICED_CONFIG_HOME: root,
      JUICED_SERVICE_URL: 'https://service.example',
    };
    let refreshes = 0;
    const client = new AccountClient(env, async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 50));
      return Response.json({
        access_token: 'a'.repeat(40),
        refresh_token: 'b'.repeat(40),
        expires_in: 300,
      });
    });
    await client.store.write({
      origin: client.origin,
      accessToken: 'c'.repeat(40),
      refreshToken: 'd'.repeat(40),
      expiresAt: 0,
    });
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => client.token(new AbortController().signal)),
    );
    assert.equal(new Set(tokens).size, 1);
    assert.equal(refreshes, 1);
    if (process.platform !== 'win32') assert.equal((await stat(client.store.path)).mode & 0o077, 0);
    const other = new CredentialStore('https://different.example', env);
    assert.equal(await other.read(), undefined);
    assert.equal((await readFile(client.store.path, 'utf8')).includes('a'.repeat(40)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent logins share one browser approval and subsequent logins reuse the saved sign-in', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-login-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    JUICED_CONFIG_HOME: root,
    JUICED_SERVICE_URL: 'https://service.example',
  };
  const account = 'acc_' + 'a'.repeat(32);
  let approvals = 0, grants = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === '/api/auth/device/code') {
      approvals++;
      return Response.json({ device_code: 'device-code', user_code: 'ABCD-EFGH', verification_uri: '/device', expires_in: 600, interval: 5 });
    }
    if (path === '/api/auth/oauth2/token') {
      grants++;
      assert.equal((await request.formData()).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      return Response.json({ access_token: 'a'.repeat(40), refresh_token: 'b'.repeat(40), expires_in: 300 });
    }
    assert.equal(path, '/v1/me');
    assert.equal(request.headers.get('authorization'), 'Bearer ' + 'a'.repeat(40));
    return Response.json({ userId: 'user', deviceId: 'device', accounts: [{ id: account, status: 'active', entitlement: 'active' }] });
  };
  const first = new AccountClient(env, fetcher), second = new AccountClient(env, fetcher);
  const signal = new AbortController().signal;
  await Promise.all([first.login(signal, true), second.login(signal, true)]);
  await new AccountClient(env, fetcher).login(signal, true);
  assert.equal(approvals, 1);
  assert.equal(grants, 1);
  assert.equal((await second.store.read())?.account, account);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'service.json'), 'utf8')), { origin: first.origin });
});

test('login refreshes a shared expired access token without requesting browser approval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-login-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JUICED_CONFIG_HOME: root, JUICED_SERVICE_URL: 'https://service.example' };
  const account = 'acc_' + 'b'.repeat(32);
  let refreshes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === '/api/auth/oauth2/token') {
      refreshes++;
      const body = await request.formData();
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'b'.repeat(40));
      return Response.json({ access_token: 'c'.repeat(40), refresh_token: 'd'.repeat(40), expires_in: 300 });
    }
    assert.equal(path, '/v1/me');
    assert.equal(request.headers.get('authorization'), 'Bearer ' + 'c'.repeat(40));
    return Response.json({ userId: 'user', deviceId: 'device', accounts: [{ id: account, status: 'active', entitlement: 'active' }] });
  };
  const client = new AccountClient(env, fetcher);
  await client.store.write({ origin: client.origin, accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40), expiresAt: 0, account });
  await Promise.all([client.login(new AbortController().signal, true), new AccountClient(env, fetcher).login(new AbortController().signal, true)]);
  assert.equal(refreshes, 1);
  assert.equal((await client.store.read())?.account, account);
  assert.equal((await client.store.read())?.refreshToken, 'd'.repeat(40));
});

test('login retries browser approval for rejected credentials but preserves credentials on service failures', async (t) => {
  for (const expired of [false, true]) {
    for (const status of [401, 503]) {
      await t.test(`${expired ? 'refresh' : 'identity'} returns ${status}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'juiced-login-retry-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        let approvals = 0;
        const client = new AccountClient({ JUICED_CONFIG_HOME: root, JUICED_SERVICE_URL: 'https://service.example' }, async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === '/api/auth/device/code') {
            approvals++;
            return Response.json({ error: 'fixture_browser_approval' }, { status: 400 });
          }
          assert.equal(path, expired ? '/api/auth/oauth2/token' : '/v1/me');
          return Response.json({ error: status === 401 ? 'not_signed_in' : 'service_unavailable' }, { status });
        });
        const saved = { origin: client.origin, accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40), expiresAt: expired ? 0 : Date.now() + 300000 };
        await client.store.write(saved);
        await assert.rejects(client.login(new AbortController().signal, true), (error) =>
          error instanceof ManagedError && (status === 401 ? error.code === 'fixture_browser_approval' : error.status === 503),
        );
        assert.equal(approvals, status === 401 ? 1 : 0);
        assert.deepEqual(await client.store.read(), saved);
      });
    }
  }
});

test('a crashed lock owner or reaper does not block credential refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-lock-'));
  try {
    const store = new CredentialStore('https://service.example', {
      JUICED_CONFIG_HOME: root,
    });
    await mkdir(dirname(store.path), { recursive: true });
    const old = new Date(Date.now() - 60000);
    // Killed between creating the lock and recording a PID, then while electing a reaper.
    for (const path of [store.path + '.lock', store.path + '.lock.reap']) {
      await writeFile(path, '');
      await utimes(path, old, old);
    }
    const started = Date.now();
    assert.equal(await store.locked(new AbortController().signal, async () => 'acquired'), 'acquired');
    assert.ok(Date.now() - started < 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed origin rejects credentials, non-loopback HTTP and insecure implicit local service', () => {
  for (const url of [
    'https://user:password@example.com',
    'http://example.com',
    'http://127.0.0.1:3000',
    'https://example.com/path',
  ])
    assert.throws(() => new AccountClient({ JUICED_SERVICE_URL: url }));
});

test('credential files stay private across replacements and reject unsafe reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-private-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JUICED_CONFIG_HOME: join(root, 'config') };
  const store = new CredentialStore('https://example.test', env);
  const directory = dirname(store.path);
  const credentials = {
    origin: store.origin, accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40),
    expiresAt: Date.now() + 300000,
  };
  await store.write(credentials);
  assert.deepEqual(await new CredentialStore(store.origin, env).read(), credentials);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    await chmod(directory, 0o777);
    await chmod(store.path, 0o644);
    await assert.rejects(store.read(), /credential file must be private/);
    await store.write(credentials);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);

    const target = join(root, 'outside.json');
    await writeFile(target, 'untouched');
    await rm(store.path);
    await symlink(target, store.path);
    await assert.rejects(store.read(), { code: 'ELOOP' });
    await store.write(credentials);
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  }
  for (const invalid of [
    '{invalid', '[]', 'x'.repeat(32 * 1024 + 1),
    JSON.stringify({ ...credentials, origin: 'https://other.test' }),
    JSON.stringify({ ...credentials, refreshToken: 'invalid' }),
    JSON.stringify({ ...credentials, account: 'invalid' }),
  ]) {
    await writeFile(store.path, invalid, { mode: 0o600 });
    await assert.rejects(store.read(), /Juiced credential/);
  }
  await store.clear();
  await store.clear();
  assert.equal(await store.read(), undefined);
});

test('legacy OS storage renews login once and saves subsequent sign-ins to the private file', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-legacy-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JUICED_CONFIG_HOME: root, JUICED_SERVICE_URL: 'https://service.example' };
  const account = 'acc_' + 'c'.repeat(32);
  let approvals = 0;
  const client = new AccountClient(env, async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === '/api/auth/device/code') {
      approvals++;
      return Response.json({ device_code: 'device-code', user_code: 'ABCD-EFGH', verification_uri: '/device', expires_in: 600, interval: 5 });
    }
    if (path === '/api/auth/oauth2/token')
      return Response.json({ access_token: 'a'.repeat(40), refresh_token: 'b'.repeat(40), expires_in: 300 });
    assert.equal(path, '/v1/me');
    assert.equal(request.headers.get('authorization'), 'Bearer ' + 'a'.repeat(40));
    return Response.json({ userId: 'user', deviceId: 'device', accounts: [{ id: account, status: 'active', entitlement: 'active' }] });
  });
  await writeFile(client.store.legacyPath, JSON.stringify({ origin: client.origin, storage: 'keyring' }), { mode: 0o600 });
  assert.equal(await client.store.read(), undefined);
  await client.login(new AbortController().signal, true);
  await client.login(new AbortController().signal, true);
  assert.equal(approvals, 1);
  const saved = await new CredentialStore(client.origin, env).read();
  assert.equal(saved?.account, account);
  assert.equal(saved?.refreshToken, 'b'.repeat(40));
  assert.equal(JSON.parse(await readFile(client.store.path, 'utf8')).storage, undefined);

  // A still-running 0.2.3 process rewrites its pointer after every refresh.
  await writeFile(client.store.legacyPath, JSON.stringify({ origin: client.origin, storage: 'keyring' }), { mode: 0o600 });
  assert.equal((await client.store.read())?.refreshToken, 'b'.repeat(40));
  await client.login(new AbortController().signal, true);
  assert.equal(approvals, 1);

  await client.store.clear();
  await writeFile(client.store.legacyPath, JSON.stringify({ origin: 'https://other.test', storage: 'keyring' }), { mode: 0o600 });
  await assert.rejects(client.store.read(), /Invalid credential origin/);
  await client.store.clear();
  assert.equal(await client.store.read(), undefined);
});

test('legacy private-file credentials move to the current file exactly once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-legacy-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JUICED_CONFIG_HOME: root };
  const store = new CredentialStore('https://example.test', env);
  const credentials = { origin: store.origin, accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40), expiresAt: Date.now() + 300000 };
  await writeFile(store.legacyPath, JSON.stringify(credentials), { mode: 0o600 });
  const [first, second] = await Promise.all([store.read(), new CredentialStore(store.origin, env).read()]);
  assert.deepEqual(first, credentials);
  assert.deepEqual(second, credentials);
  // One owner per refresh token: the older path no longer holds a copy.
  await assert.rejects(stat(store.legacyPath), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), credentials);
  if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  await store.clear();
  assert.equal(await store.read(), undefined);
});
