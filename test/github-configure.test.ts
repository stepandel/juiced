import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import type { AppEnvironment } from '@cantelop/sdk';
import { HELP, parseArguments } from '../src/args.js';
import { configureGitHub, GITHUB_TOKEN_URL, promptGitHubToken, verifyGitHubToken } from '../src/github-configure.js';

const signal = () => new AbortController().signal;
function fixture(interactive = false) {
  let output = '';
  const input = Object.assign(new PassThrough(), { isTTY: interactive, isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  const io = { stdin: input, stderr: Object.assign(new Writable({ write(bytes, _encoding, callback) { output += bytes; callback(); } }), { isTTY: interactive }) };
  const calls: unknown[] = [];
  const api: AppEnvironment = {
    async set(name, value, options) { calls.push({ name, value, secret: options?.secret }); return { revision: 7, status: 'pending' }; },
    async unset() { throw new Error('Unexpected unset'); },
    async status() { throw new Error('Unexpected status'); },
    async wait(revision) { calls.push({ wait: revision }); return { revision, status: 'applied' }; },
  };
  const services = {
    env: {} as NodeJS.ProcessEnv,
    async localToken() { calls.push('local-token'); return undefined as string | undefined; },
    async openBrowser(url: string) { calls.push({ browser: url }); },
    async prompt() { calls.push('prompt'); return 'fixture-pasted-token'; },
    fetch: (async (url, init) => {
      assert.equal(url, 'https://api.github.com/user');
      assert.equal(init?.redirect, 'error');
      calls.push({ verify: new Headers(init?.headers).get('Authorization') });
      return Response.json({ login: 'octocat' });
    }) as typeof fetch,
  };
  return { io, calls, api, services, output: () => output };
}

test('github-configure is app-wide, reserves its command name, and rejects token arguments and session flags', () => {
  for (const stdin of [false, true]) {
    assert.deepEqual(parseArguments(['claude', 'github-configure', ...(stdin ? ['--stdin'] : [])], { JUICED_WORKSPACE: 'other-project' }), {
      command: 'claude', action: 'github-configure', workspace: undefined, stdin, argv: [],
    });
  }
  for (const args of [
    ['--workspace', 'chosen', 'claude', 'github-configure'], ['--resume', 'claude', 'github-configure'],
    ['--session', `ses_${'1'.repeat(32)}`, 'claude', 'github-configure'],
    ['claude', 'github-configure', 'fixture-token'], ['claude', 'github-configure', '--token', 'fixture-token'],
    ['claude', 'github-configure', '--stdin', '--stdin'],
  ]) assert.throws(() => parseArguments(args, {}));
  assert.deepEqual(parseArguments(['claude', 'github-configure', '--help'], {}), { command: 'help', workspace: undefined, argv: ['github-configure'] });
  assert.deepEqual(parseArguments(['claude', '--', 'github-configure'], {}), { command: 'claude', action: 'run', workspace: undefined, argv: ['github-configure'] });
  assert.match(HELP, /juiced claude github-configure \[--stdin\]/);
});

test('environment credentials are verified before storing a secret and waiting for propagation', async () => {
  const f = fixture();
  f.services.env.GH_TOKEN = 'fixture-environment-token';
  await configureGitHub(f.api, false, f.io, signal(), f.services);
  assert.deepEqual(f.calls, [
    { verify: 'Bearer fixture-environment-token' },
    { name: 'GH_TOKEN', value: 'fixture-environment-token', secret: true }, { wait: 7 },
  ]);
  assert.match(f.output(), /Authenticated with GitHub as octocat/);
  assert.match(f.output(), /all Juiced workspaces/);
  assert.match(f.output(), /\[1\/3\].*Finding.*\[2\/3\].*Verifying.*\[3\/3\].*Saving/s);
  assert.match(f.output(), /\/exit.*juiced --resume claude/s);
  assert.match(f.output(), /preserves your conversation and history/);
  assert.doesNotMatch(f.output(), /--new|fresh session/);
  assert.doesNotMatch(f.output(), /fixture-environment-token/);
});

test('stdin takes precedence over existing credentials and works without a terminal', async () => {
  const f = fixture();
  f.services.env.GH_TOKEN = 'ignored-token';
  f.io.stdin.end('fixture-stdin-token\r\n');
  await configureGitHub(f.api, true, f.io, signal(), f.services);
  assert.deepEqual(f.calls, [
    { verify: 'Bearer fixture-stdin-token' }, { name: 'GH_TOKEN', value: 'fixture-stdin-token', secret: true }, { wait: 7 },
  ]);
  assert.doesNotMatch(f.output(), /fixture-stdin-token|ignored-token/);
});

test('existing local gh credentials are reused without opening a browser or prompting', async () => {
  const f = fixture();
  f.services.localToken = async () => 'fixture-gh-token';
  await configureGitHub(f.api, false, f.io, signal(), f.services);
  assert.deepEqual(f.calls, [
    { verify: 'Bearer fixture-gh-token' }, { name: 'GH_TOKEN', value: 'fixture-gh-token', secret: true }, { wait: 7 },
  ]);
  assert.match(f.output(), /local gh credential for github.com/);
  assert.doesNotMatch(f.output(), /fixture-gh-token/);
});

test('interactive setup opens token creation and verifies the hidden paste, with a URL fallback', async () => {
  for (const browserFails of [false, true]) {
    const f = fixture(true);
    if (browserFails) f.services.openBrowser = async () => { throw new Error('browser unavailable'); };
    await configureGitHub(f.api, false, f.io, signal(), f.services);
    assert.deepEqual(f.calls, ['local-token', ...(browserFails ? [] : [{ browser: GITHUB_TOKEN_URL }]), 'prompt',
      { verify: 'Bearer fixture-pasted-token' }, { name: 'GH_TOKEN', value: 'fixture-pasted-token', secret: true }, { wait: 7 }]);
    assert.match(f.output(), /https:\/\/github.com\/settings\/personal-access-tokens\/new/);
    assert.match(f.output(), /Choose the repository owner and repositories/);
    if (browserFails) assert.match(f.output(), /Open the URL above/);
    assert.doesNotMatch(f.output(), /fixture-pasted-token/);
  }
});

test('missing noninteractive credentials fail without opening a browser, prompting, or saving', async () => {
  const f = fixture();
  await assert.rejects(configureGitHub(f.api, false, f.io, signal(), f.services), /interactive terminal.*--stdin/);
  assert.deepEqual(f.calls, ['local-token']);
});

test('invalid and rejected credentials never replace the existing secret or leak diagnostics', async () => {
  for (const token of ['', 'fixture\ntoken', 'fixture\0token', 'x'.repeat(65537)]) {
    const f = fixture(true);
    f.services.prompt = async () => token;
    await assert.rejects(configureGitHub(f.api, false, f.io, signal(), f.services), /GitHub token must/);
    assert.equal(f.calls.some(call => typeof call === 'object' && call !== null && 'name' in call), false);
  }
  for (const status of [401, 403, 429, 500]) {
    const f = fixture();
    f.services.env.GH_TOKEN = 'fixture-invalid-token';
    f.services.fetch = async () => new Response('fixture-invalid-token', { status });
    await assert.rejects(configureGitHub(f.api, false, f.io, signal(), f.services), error => {
      assert.doesNotMatch(String(error), /fixture-invalid-token/); return true;
    });
    assert.deepEqual(f.calls, []);
    assert.doesNotMatch(f.output(), /GitHub configured|fixture-invalid-token/);
  }
  await assert.rejects(verifyGitHubToken('fixture-token', async () => { throw new Error('Authorization: fixture-token'); }, signal()), /Unable to verify/);
  await assert.rejects(verifyGitHubToken('fixture-token', async () => Response.json({ login: '\u001b[31m' }), signal()), /invalid account response/);
});

test('failed propagation is not reported as successful configuration, and aborted setup never reads credentials', async () => {
  const f = fixture();
  f.services.env.GH_TOKEN = 'fixture-token';
  f.api.wait = async () => { throw new Error('Propagation failed'); };
  await assert.rejects(configureGitHub(f.api, false, f.io, signal(), f.services), /Propagation failed/);
  assert.doesNotMatch(f.output(), /GitHub configured/);
  const cancelled = fixture();
  await assert.rejects(configureGitHub(cancelled.api, false, cancelled.io, AbortSignal.abort(), cancelled.services));
  assert.deepEqual(cancelled.calls, []);
});

test('hidden token input suppresses echo and restores terminal mode on submit, Ctrl+C, EOF, and abort', async () => {
  for (const outcome of ['submit', 'ctrl-c', 'eof', 'abort']) {
    const f = fixture(true);
    const controller = new AbortController();
    const reading = promptGitHubToken(f.io, controller.signal);
    assert.equal(f.io.stdin.isRaw, true);
    if (outcome === 'abort') controller.abort();
    else if (outcome === 'eof') f.io.stdin.end();
    else f.io.stdin.write(outcome === 'submit' ? 'fixture-hidden-token\r' : 'fixture-hidden-token\u0003');
    if (outcome === 'submit') assert.equal(await reading, 'fixture-hidden-token');
    else await assert.rejects(reading);
    assert.equal(f.io.stdin.isRaw, false);
    assert.match(f.output(), /Paste GitHub token \(hidden\):/);
    assert.doesNotMatch(f.output(), /fixture-hidden-token/);
  }
});
