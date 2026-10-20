import assert from 'node:assert/strict';
import test from 'node:test';
import { backoffMs, isCursorExpired, isTransient, isViewMissing, messageId, withTimeout } from '../src/transport.js';

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
