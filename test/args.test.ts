import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from '../src/args.js';

test('passes every argument after claude unchanged', () => {
  const argv = ['--help', '--model', 'sonnet', '--workspace', 'native-value', 'a prompt; $(literal)'];
  assert.deepEqual(parseArguments(['claude', ...argv], {}), { command: 'claude', workspace: undefined, argv });
});

test('selects a persistent workspace before the command or from the environment', () => {
  assert.equal(parseArguments(['--workspace', 'project-a', 'claude'], {}).workspace, 'project-a');
  assert.equal(parseArguments(['--workspace=project-b', 'claude'], {}).workspace, 'project-b');
  assert.equal(parseArguments(['claude'], { JUICED_WORKSPACE: 'project-c' }).workspace, 'project-c');
  assert.throws(() => parseArguments(['--workspace', '../other', 'claude'], {}), /Workspace/);
  assert.throws(() => parseArguments(['--workspace'], {}), /Workspace/);
});

test('supports help and login and rejects unknown commands', () => {
  assert.equal(parseArguments([], {}).command, 'help');
  assert.equal(parseArguments(['--help'], {}).command, 'help');
  assert.equal(parseArguments(['login'], {}).command, 'login');
  assert.throws(() => parseArguments(['something-else'], {}), /Unknown command/);
});

test('Git maintenance is scoped under claude and directions are explicit', () => {
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', 'sync', '--to-workspace', '--include-uncommitted'], {}), {
    command: 'sync', workspace: 'chosen', direction: 'to-workspace', includeUncommitted: true, argv: [],
  });
  assert.equal(parseArguments(['claude', 'sync', '--from-workspace'], {}).command, 'sync');
  assert.equal(parseArguments(['claude', 'fast-forward'], {}).command, 'fast-forward');
  for (const flags of [[], ['--to-workspace', '--from-workspace'], ['--from-workspace', '--include-uncommitted'], ['--to-workspace', '--force'], ['--to-workspace', '--to-workspace']]) {
    assert.throws(() => parseArguments(['claude', 'sync', ...flags], {}), /Usage/);
  }
  assert.throws(() => parseArguments(['claude', 'fast-forward', '--force'], {}), /Usage/);
  assert.deepEqual(parseArguments(['claude', '--', 'sync'], {}).argv, ['sync']);
  assert.deepEqual(parseArguments(['claude', '--model', 'sonnet', 'sync'], {}).argv, ['--model', 'sonnet', 'sync']);
});
