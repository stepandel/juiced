import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from '../src/args.js';

test('passes every argument after claude unchanged', () => {
  const argv = ['--help', '--model', 'sonnet', '--workspace', 'native-value', 'a prompt; $(literal)'];
  assert.deepEqual(parseArguments(['claude', ...argv], {}), { command: 'claude', workspace: 'default', argv });
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
