import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteAppError } from '@cantelop/sdk';
import { backoffMs, isAdmissionTimeout, isCursorExpired, isTransient, isViewMissing, messageId, retryAdmission, withTimeout } from '../src/transport.js';
import { transferFailure } from '../src/agent/publications.js';
import { GitError } from '../src/git.js';

const status = (code: number, message = 'x') => Object.assign(new Error(message), { status: code });

test('isTransient retries only status 0 and 5xx when a status is present', () => {
  assert.equal(isTransient(status(0)), true);
  assert.equal(isTransient(status(500)), true);
  assert.equal(isTransient(status(503)), true);
  for (const code of [400, 401, 404, 409, 429]) assert.equal(isTransient(status(code, 'network stream connection timed out')), false, String(code));
  // A status wins over the AbortError name.
  assert.equal(isTransient(Object.assign(new DOMException('aborted', 'AbortError'), { status: 403 })), false);
});

test('isTransient classifies status-less errors by name and message', () => {
  assert.equal(isTransient(new DOMException('This operation was aborted', 'AbortError')), true);
  for (const message of ['fetch failed', 'Network error', 'socket hang up', 'other side closed: terminated', 'Connection reset', 'The stream ended', 'Request timed out'])
    assert.equal(isTransient(new Error(message)), true, message);
  assert.equal(isTransient({ message: 'socket hang up' }), true);
  assert.equal(isTransient(new Error('Invalid session')), false);
  assert.equal(isTransient(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), false);
  for (const value of [undefined, null, 'network', 42]) assert.equal(isTransient(value), false);
});

test('backoffMs doubles from the base up to the cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 100].map(attempt => backoffMs(attempt)), [250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  assert.equal(backoffMs(2, { base: 100, max: 300 }), 300);
});

test('shared message IDs and Cantelop error codes', () => {
  assert.match(messageId(), /^msg_[a-f0-9]{32}$/);
  assert.equal(messageId('0b8a0d5e-1c2f-4e3a-9b7d-6f5e4d3c2b1a'), 'msg_0b8a0d5e1c2f4e3a9b7d6f5e4d3c2b1a');
  assert.equal(isViewMissing({ code: 'session_view_not_found' }), true);
  assert.equal(isViewMissing({ code: 'event_cursor_expired' }), false);
  assert.equal(isCursorExpired({ code: 'event_stream_reset' }), true);
  assert.equal(isCursorExpired(undefined), false);
});

test('withTimeout forwards the parent reason, times out with TimeoutError and unregisters', async () => {
  const parent = new AbortController();
  const reason = new Error('closed');
  const pending = withTimeout(parent.signal, 60_000, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  parent.abort(reason);
  await assert.rejects(pending, error => error === reason);

  // Like AbortSignal.timeout, the deadline timer is unref'd; hold the loop open here.
  const alive = setTimeout(() => {}, 10_000);
  await assert.rejects(withTimeout(new AbortController().signal, 5, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))),
    (error: Error) => error.name === 'TimeoutError');
  clearTimeout(alive);

  const aborted = AbortSignal.abort(reason);
  assert.equal(await withTimeout(aborted, 1000, async signal => signal.reason), reason);

  // Settled calls leave no listener behind on the long-lived parent.
  const long = new AbortController();
  let added = 0, removed = 0;
  const add = long.signal.addEventListener.bind(long.signal), remove = long.signal.removeEventListener.bind(long.signal);
  long.signal.addEventListener = ((...args: Parameters<typeof add>) => { added++; add(...args); }) as typeof add;
  long.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed++; remove(...args); }) as typeof remove;
  for (let i = 0; i < 3; i++) assert.equal(await withTimeout(long.signal, 1000, async () => i), i);
  assert.deepEqual([added, removed], [3, 3]);
});

test('an admission timeout is retryable whatever its HTTP status', () => {
  for (const code of [0, 408, 409, 429, 503]) {
    const error = new RemoteAppError('session_admission_timeout', code);
    assert.equal(isAdmissionTimeout(error), true);
    assert.equal(isTransient(error), true, String(code));
  }
  assert.equal(isAdmissionTimeout(new RemoteAppError('session_not_found', 404)), false);
});

test('retryAdmission waits out admission timeouts within its budget and passes other failures through', async () => {
  const signal = new AbortController().signal;
  let calls = 0, waited = 0;
  assert.equal(await retryAdmission(signal, async () => {
    if (++calls < 3) throw new RemoteAppError('session_admission_timeout', 409);
    return 'admitted';
  }, () => waited++, 30_000), 'admitted');
  assert.equal(calls, 3);
  assert.equal(waited, 1);

  calls = 0;
  await assert.rejects(retryAdmission(signal, async () => { calls++; throw new RemoteAppError('forbidden', 403); }), /forbidden/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(retryAdmission(signal, async () => { calls++; throw new RemoteAppError('session_admission_timeout', 409); }, undefined, 1500), /session_admission_timeout/);
  assert.ok(calls >= 2);
});

test('a failed publication download is reported as retryable, not as a conflict', () => {
  const manifest = { head: 'a'.repeat(40), sourceBranch: 'main' } as never;
  const snapshot = { id: 'x', kind: 'snapshot' as const, summary: 's', expiresAt: 0, manifest, paths: [], fileCount: 0 };
  const admission = transferFailure(snapshot, new RemoteAppError('session_admission_timeout', 409), 'fallback');
  assert.equal(admission.status, 'failed');
  assert.match(admission.message, /session_admission_timeout/);
  assert.match(admission.message, /not a file conflict/);
  assert.match(admission.message, /Local files, HEAD and the index were not changed/);
  assert.match(admission.message, /publish_snapshot/);
  const local = transferFailure(snapshot, new Error('Local edits overlap this snapshot. Nothing was applied.'), 'fallback');
  assert.deepEqual(local, { status: 'conflict', message: 'Local edits overlap this snapshot. Nothing was applied.' });
  // An expired or cancelled application is not a connection failure.
  assert.equal(transferFailure(snapshot, new DOMException('expired', 'TimeoutError'), 'fallback').status, 'conflict');
  const upload = transferFailure({ id: 'x', kind: 'upload', summary: 's', expiresAt: 0, head: 'a'.repeat(40), sourceBranch: null, includeUncommitted: true }, new RemoteAppError('command_outcome_unknown', 0, undefined, { cause: new Error('fetch failed') }), 'fallback');
  assert.equal(upload.status, 'failed');
  assert.match(upload.message, /pull_local_changes/);
});

test('publication failures retain local conflicts and filesystem errors containing transport words', () => {
  const snapshot = { kind: 'snapshot' as const } as Parameters<typeof transferFailure>[0];
  for (const error of [
    new Error('Local edits overlap this snapshot. Nothing was applied. Review /tmp/stream-app/.git/juiced-publications/snapshot.patch'),
    new GitError('error: connection.ts: patch does not apply', 1),
    Object.assign(new Error("ENOSPC: no space left on device, write '/tmp/network-app/.git/juiced-publications/receipt.json'"), { code: 'ENOSPC' }),
  ]) {
    assert.deepEqual(transferFailure(snapshot, error, 'fallback'), { status: 'conflict', message: error.message });
  }
});
