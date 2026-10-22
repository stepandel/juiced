import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { RemoteAppError, type WorkspaceAuthRef } from '@cantelop/sdk';
import { ensureLogin } from '../src/login.js';
import { until } from './fixtures/wait.js';

function fixture(t: test.TestContext, submit: (code: string) => Promise<boolean>) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = Object.assign(new PassThrough(), { isTTY: true });
  let output = '';
  const cancelled: string[] = [];
  stderr.on('data', bytes => { output += String(bytes); });
  t.after(() => { stdin.destroy(); stderr.destroy(); });
  const auth = {
    async status() { return false; },
    async login() { return { authenticated: false, attemptId: 'attempt', url: 'https://claude.example/authorize' }; },
    async submitCode({ code }: { code: string }) { return submit(code); },
    async cancelLogin({ attemptId }: { attemptId: string }) { cancelled.push(attemptId); },
  } as unknown as WorkspaceAuthRef;
  const wait = (check: () => boolean) => until(check, { attempts: 100, message: () => output });
  return { stdin, stderr, auth, cancelled, wait, get output() { return output; } };
}

test('expired Claude authorization explains how to restart in the selected workspace', async t => {
  const expired = new RemoteAppError('login_not_active', 409);
  const f = fixture(t, async () => { throw expired; });
  const checked = assert.rejects(ensureLogin(f.auth, new AbortController().signal, { workspace: 'chosen', io: f }), error => {
    assert.match((error as Error).message, /sign-in attempt expired or was cancelled/);
    assert.match((error as Error).message, /juiced --workspace chosen claude login/);
    assert.match((error as Error).message, /new authorization URL and code/);
    assert.equal((error as Error).cause, expired);
    return true;
  });
  await f.wait(() => f.output.includes('Paste the authorization code:'));
  f.stdin.write('expired-code\r');
  await checked;
  assert.deepEqual(f.cancelled, ['attempt']);
  assert.equal(f.output.includes('Claude is signed in'), false);
});

test('rejected authorization codes can still be retried within the same attempt', async t => {
  const codes: string[] = [];
  const f = fixture(t, async code => {
    codes.push(code);
    if (code === 'bad-code') throw new RemoteAppError('code_rejected', 400);
    return true;
  });
  const running = ensureLogin(f.auth, new AbortController().signal, { io: f });
  await f.wait(() => f.output.includes('Paste the authorization code:'));
  f.stdin.write('bad-code\r');
  await f.wait(() => f.output.split('Paste the authorization code:').length === 3);
  assert.match(f.output, /Claude rejected that code. Try again/);
  f.stdin.write('valid-code\r');
  await running;
  assert.deepEqual(codes, ['bad-code', 'valid-code']);
  assert.deepEqual(f.cancelled, []);
  assert.match(f.output, /Claude is signed in to this workspace/);
});

test('other authorization failures retain their original error', async t => {
  const denied = new RemoteAppError('permission_denied', 403);
  const f = fixture(t, async () => { throw denied; });
  const checked = assert.rejects(ensureLogin(f.auth, new AbortController().signal, { io: f }), error => error === denied);
  await f.wait(() => f.output.includes('Paste the authorization code:'));
  f.stdin.write('code\r');
  await checked;
  assert.deepEqual(f.cancelled, ['attempt']);
});

test('noninteractive sign-in instructions retain an explicit workspace', async t => {
  const f = fixture(t, async () => true);
  f.stdin.isTTY = false;
  await assert.rejects(ensureLogin(f.auth, new AbortController().signal, { workspace: 'chosen', io: f }), /Run juiced --workspace chosen claude login in an interactive terminal/);
  assert.deepEqual(f.cancelled, []);
});
