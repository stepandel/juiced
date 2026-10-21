import assert from 'node:assert/strict';
import test from 'node:test';
import { cliVersionAtLeast } from '../../contracts/cli-version.js';

test('release candidates must be explicitly allowed by the service minimum', () => {
  assert.equal(cliVersionAtLeast('0.2.0-rc.1', '0.2.0-rc.1'), true);
  assert.equal(cliVersionAtLeast('0.2.0-rc.2', '0.2.0-rc.1'), true);
  assert.equal(cliVersionAtLeast('0.2.0-rc.1', '0.2.0'), false);
  assert.equal(cliVersionAtLeast('0.2.0', '0.2.0-rc.1'), true);
  assert.equal(cliVersionAtLeast('0.2.0-rc.1', '0.1.9'), true);
  assert.equal(cliVersionAtLeast('0.1.9', '0.2.0-rc.1'), false);
});

test('CLI versions follow SemVer precedence and ignore build metadata', () => {
  const ordered = ['0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-alpha.beta', '0.2.0-beta',
    '0.2.0-beta.2', '0.2.0-beta.11', '0.2.0-rc.1', '0.2.0', '0.2.1', '0.10.0', '1.0.0'];
  for (let n = 1; n < ordered.length; n++) {
    assert.equal(cliVersionAtLeast(ordered[n]!, ordered[n - 1]!), true);
    assert.equal(cliVersionAtLeast(ordered[n - 1]!, ordered[n]!), false);
  }
  assert.equal(cliVersionAtLeast('0.2.0-rc.10', '0.2.0-rc.2'), true);
  assert.equal(cliVersionAtLeast('0.2.0-rc.1+build.5', '0.2.0-rc.1+build.9'), true);
  assert.equal(cliVersionAtLeast('0.2.0-rc.99999999999999999999', '0.2.0-rc.99999999999999999998'), true);
});

test('malformed and oversized CLI versions fail closed on either side', () => {
  for (const value of ['', 'v0.2.0', '0.2', '00.2.0', '0.2.0-rc.01', '0.2.0-', '0.2.0-rc_1',
    '0.2.0\n', '0.2.0+bad..build', '99999999999999999999.2.0', '0.2.0-' + 'a'.repeat(128)]) {
    assert.equal(cliVersionAtLeast(value, '0.2.0-rc.1'), false, value);
    assert.equal(cliVersionAtLeast('0.2.0', value), false, value);
  }
});
