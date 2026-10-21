import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIP } from '../src/client-ip.js';
test('rate limit identity uses trusted socket and rejects forged forwarding chains', () => {
  assert.equal(clientIP('203.0.113.10', '1.2.3.4', []), '203.0.113.10');
  assert.equal(clientIP('127.0.0.1', '1.2.3.4,203.0.113.10', ['127.0.0.1/32']), '203.0.113.10');
  assert.equal(clientIP('::ffff:127.0.0.1', '203.0.113.10', ['127.0.0.1/32']), '203.0.113.10');
  assert.equal(clientIP('127.0.0.1', 'invalid', ['127.0.0.1/32']), '127.0.0.1');
  assert.throws(() => clientIP('127.0.0.1', null, ['0.0.0.0/99']));
});
