import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../src/account/invocation.js';
import { CredentialStore } from '../src/account/store.js';
import { AccountClient } from '../src/account/client.js';
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
  assert.throws(() =>
    parseInvocation(['--self-managed', '--account', 'acc_' + 'a'.repeat(32), 'claude'], {}),
  );
  assert.throws(() => parseInvocation(['claude'], { JUICED_MODE: 'other' }));
  assert.throws(() => parseInvocation(['login', '--all'], {}));
});

test('credentials are private, origin scoped and serialize refresh across concurrent calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-credentials-'));
  try {
    const env = {
      JUICED_CREDENTIAL_STORE: 'file',
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

test('a crashed lock owner or reaper does not block credential refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-lock-'));
  try {
    const store = new CredentialStore('https://service.example', {
      JUICED_CREDENTIAL_STORE: 'file',
      JUICED_CONFIG_HOME: root,
    });
    await mkdir(root, { recursive: true });
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

test('OS credential storage keeps refresh secrets out of the fallback file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-keyring-'));
  let secret: string | null = null;
  const entry = {
    async getPassword() {
      return secret;
    },
    async setPassword(v: string) {
      secret = v;
    },
    async deletePassword() {
      secret = null;
      return true;
    },
  };
  try {
    const store = new CredentialStore(
      'https://example.test',
      { JUICED_CONFIG_HOME: root },
      async () => entry,
    );
    const credentials = {
      origin: store.origin,
      accessToken: 'a'.repeat(40),
      refreshToken: 'b'.repeat(40),
      expiresAt: Date.now() + 300000,
    };
    await store.write(credentials);
    assert.equal((await readFile(store.path, 'utf8')).includes(credentials.refreshToken), false);
    assert.deepEqual(await store.read(), credentials);
    await store.clear();
    assert.equal(secret, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
