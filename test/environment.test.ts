import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import type { AppEnvironment } from '@cantelop/sdk';
import { HELP, parseArguments } from '../src/args.js';
import { readEnvironmentValue, updateEnvironment } from '../src/environment.js';

test('app environment commands require stdin, default to secret storage, and reject workspace scope', () => {
  assert.deepEqual(parseArguments(['env', 'set', 'GH_TOKEN', '--stdin'], {}), { command: 'env', action: 'set', name: 'GH_TOKEN', secret: true, workspace: undefined, argv: [] });
  assert.equal((parseArguments(['env', 'unset', 'MODEL', '--plain'], {}) as { secret: boolean }).secret, false);
  for (const args of [['env', 'set', 'GH_TOKEN', 'secret'], ['env', 'set', 'GH_TOKEN'], ['env', 'set', 'CANTELOP_INTEGRATION_TOKEN', '--stdin'], ['env', 'unset', 'GH_TOKEN', '--stdin'], ['--workspace', 'project', 'env', 'unset', 'GH_TOKEN']]) assert.throws(() => parseArguments(args, {}));
  assert.match(HELP, /juiced env set NAME --stdin/);
});

test('environment stdin preserves values and bounds input without printing secrets', async () => {
  const signal = new AbortController().signal;
  assert.equal(await readEnvironmentValue(Readable.from(['fixture-token\r\n']), signal), 'fixture-token');
  for (const bytes of [Buffer.from(''), Buffer.from('a\0b'), Buffer.alloc(65540), Buffer.from([0xff])]) await assert.rejects(readEnvironmentValue(Readable.from([bytes]), signal));
  const input = Object.assign(Readable.from(['token']), { isTTY: true });
  await assert.rejects(readEnvironmentValue(input, signal), /Pipe/);
  await assert.rejects(readEnvironmentValue(Readable.from(['token']), AbortSignal.abort()), /abort/i);
});

test('Juiced waits for the SDK revision and logs only metadata; unset never reads stdin', async () => {
  const calls: unknown[] = []; let output = '';
  const update = { revision: 7, status: 'pending' as const };
  const api: AppEnvironment = {
    async set(name, value, options) { calls.push({ name, value, secret: options?.secret }); return update; },
    async unset(name) { calls.push({ unset: name }); return update; },
    async status() { throw new Error('unexpected'); },
    async wait(revision) { calls.push({ wait: revision }); return { revision, status: 'applied' }; },
  };
  const stderr = new Writable({ write(bytes, _encoding, callback) { output += bytes; callback(); } });
  await updateEnvironment(api, 'set', 'GH_TOKEN', true, { stdin: Readable.from(['fixture-token\n']), stderr }, new AbortController().signal);
  await updateEnvironment(api, 'unset', 'GH_TOKEN', true, { stdin: new Readable({ read() { throw new Error('stdin read'); } }), stderr }, new AbortController().signal);
  assert.deepEqual(calls, [{ name: 'GH_TOKEN', value: 'fixture-token', secret: true }, { wait: 7 }, { unset: 'GH_TOKEN' }, { wait: 7 }]);
  assert.doesNotMatch(output, /fixture-token/);
  assert.match(output, /Running processes keep/);
  assert.match(output, /existing Claude conversation.*\/exit.*juiced claude.*same terminal tab/);
});
