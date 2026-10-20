import assert from 'node:assert/strict';
import test from 'node:test';
import { HELP, parseArguments } from '../src/args.js';

test('passes Claude flags and prompts through unchanged', () => {
  const argv = ['--help', '--model', 'sonnet', '--workspace', 'native-value', 'a prompt; $(literal)'];
  assert.deepEqual(parseArguments(['claude', ...argv], {}), { command: 'claude', action: 'run', workspace: undefined, argv });
  assert.deepEqual(parseArguments(['claude'], {}), { command: 'claude', action: 'run', workspace: undefined, argv: [] });
});

test('selects a persistent workspace before the command or from the environment', () => {
  assert.equal(parseArguments(['--workspace', 'project-a', 'claude'], {}).workspace, 'project-a');
  assert.equal(parseArguments(['--workspace=project-b', 'claude'], {}).workspace, 'project-b');
  assert.equal(parseArguments(['claude'], { JUICED_WORKSPACE: 'project-c' }).workspace, 'project-c');
  assert.throws(() => parseArguments(['--workspace', '../other', 'claude'], {}), /Workspace/);
  assert.throws(() => parseArguments(['--workspace'], {}), /Workspace/);
});

test('a leading --new starts fresh without forwarding the Juiced option to Claude', () => {
  assert.deepEqual(parseArguments(['claude', '--new', '--model', 'sonnet'], {}), {
    command: 'claude', action: 'run', workspace: undefined, newSession: true, argv: ['--model', 'sonnet'],
  });
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', '--new', '--', 'login'], {}), {
    command: 'claude', action: 'run', workspace: 'chosen', newSession: true, argv: ['login'],
  });
  assert.deepEqual(parseArguments(['claude', '--', '--new'], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: ['--new'],
  });
  assert.throws(() => parseArguments(['claude', '--new', '--new'], {}), /only once/);
});

test('removed global --resume fails with guidance while explicit session selection remains available', () => {
  for (const args of [['--resume', 'claude'], ['--workspace', 'chosen', '--resume', 'claude'], ['--resume', 'claude', '--new'], ['--resume=latest', 'claude']]) {
    assert.throws(() => parseArguments(args, {}), /--resume has been removed.*original terminal tab.*juiced claude --session ID/);
  }
  assert.deepEqual(parseArguments(['claude', '--resume', 'native-id'], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: ['--resume', 'native-id'],
  });
  assert.doesNotMatch(HELP, /--resume/);
});

test('session selection follows claude and is consumed before Claude arguments', () => {
  const id = `ses_${'1'.repeat(32)}`;
  assert.deepEqual(parseArguments(['claude', '--session', id], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: [], session: id,
  });
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', '--session', id], {}), {
    command: 'claude', action: 'run', workspace: 'chosen', argv: [], session: id,
  });
  assert.deepEqual(parseArguments(['claude', `--session=${id}`, '--model', 'sonnet'], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: ['--model', 'sonnet'], session: id,
  });
  assert.deepEqual(parseArguments(['claude', '--session', id, '--', 'login'], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: ['login'], session: id,
  });
  assert.deepEqual(parseArguments(['claude', '--', '--session', id], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: ['--session', id],
  });
  assert.deepEqual(parseArguments(['claude', '--session-id', 'native-id'], {}), {
    command: 'claude', action: 'run', workspace: undefined, argv: ['--session-id', 'native-id'],
  });
  for (const args of [['--session', id, 'claude'], ['--workspace', 'chosen', '--session', id, 'claude'], [`--session=${id}`, 'claude']]) {
    assert.throws(() => parseArguments(args, {}), /Run juiced claude --session ID/);
  }
  for (const flags of [['--new', '--session', id], ['--session', id, '--new']]) {
    assert.throws(() => parseArguments(['claude', ...flags], {}), /cannot be combined/);
  }
  assert.throws(() => parseArguments(['claude', '--session', id, '--session', id], {}), /only once/);
  for (const command of ['login', 'github-configure', 'sync', 'fast-forward', 'delete', 'ls', 'peek', 'sessions']) {
    assert.throws(() => parseArguments(['claude', '--session', id, command], {}), /interactive/);
  }
  for (const args of [['claude', '--session'], ['claude', '--session', 'invalid'], ['claude', '--session=']]) {
    assert.throws(() => parseArguments(args, {}), /Invalid Juiced session ID/);
  }
  assert.match(HELP, /juiced \[--workspace SLUG\] claude --session ID/);
  assert.doesNotMatch(HELP, /juiced --session/);
});

test('supports global help and version and rejects unknown harnesses', () => {
  assert.equal(parseArguments([], {}).command, 'help');
  assert.equal(parseArguments(['--help'], {}).command, 'help');
  assert.equal(parseArguments(['--version'], {}).command, 'version');
  assert.throws(() => parseArguments(['codex', 'login'], {}), /Unknown command/);
  assert.throws(() => parseArguments(['something-else'], {}), /Unknown command/);
});

test('login is a Claude action with workspace selection', () => {
  assert.deepEqual(parseArguments(['claude', 'login'], {}), {
    command: 'claude', action: 'login', workspace: undefined, argv: [],
  });
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', 'login'], {}), {
    command: 'claude', action: 'login', workspace: 'chosen', argv: [],
  });
  assert.equal(parseArguments(['claude', 'login'], { JUICED_WORKSPACE: 'chosen' }).workspace, 'chosen');
  for (const args of [['login'], ['--workspace', 'chosen', 'login']]) {
    assert.throws(() => parseArguments(args, {}), /Run juiced claude login/);
  }
  for (const extra of ['--help', '--force', 'prompt']) {
    assert.throws(() => parseArguments(['claude', 'login', extra], {}), /Usage: juiced claude login/);
  }
  assert.match(HELP, /juiced \[--workspace SLUG\] claude login/);
  assert.doesNotMatch(HELP, /juiced \[--workspace SLUG\] login/);
});

test('Git maintenance is scoped under claude and directions are explicit', () => {
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', 'sync', '--to-workspace', '--include-uncommitted'], {}), {
    command: 'claude', action: 'sync', workspace: 'chosen', direction: 'to-workspace', includeUncommitted: true, argv: [],
  });
  assert.deepEqual(parseArguments(['claude', 'sync', '--from-workspace'], {}), {
    command: 'claude', action: 'sync', workspace: undefined, direction: 'from-workspace', includeUncommitted: false, argv: [],
  });
  assert.deepEqual(parseArguments(['claude', 'fast-forward'], {}), {
    command: 'claude', action: 'fast-forward', workspace: undefined, argv: [],
  });
  for (const command of ['sync', 'fast-forward']) {
    assert.throws(() => parseArguments([command], {}), /Unknown command/);
  }
  for (const flags of [[], ['--to-workspace', '--from-workspace'], ['--from-workspace', '--include-uncommitted'], ['--to-workspace', '--force'], ['--to-workspace', '--to-workspace']]) {
    assert.throws(() => parseArguments(['claude', 'sync', ...flags], {}), /Usage/);
  }
  assert.throws(() => parseArguments(['claude', 'fast-forward', '--force'], {}), /Usage/);
});

test('reserved subcommand names can still be sent as literal Claude prompts', () => {
  for (const prompt of ['login', 'github-configure', 'sync', 'fast-forward', 'delete', 'sessions']) {
    assert.deepEqual(parseArguments(['claude', '--', prompt], {}), {
      command: 'claude', action: 'run', workspace: undefined, argv: [prompt],
    });
    assert.deepEqual(parseArguments(['claude', '--model', 'sonnet', prompt], {}), {
      command: 'claude', action: 'run', workspace: undefined, argv: ['--model', 'sonnet', prompt],
    });
  }
});

test('file sync requires explicit opt-in and rejects Git transfer options', () => {
  assert.deepEqual(parseArguments(['claude', 'sync', '--files'], {}), {
    command: 'claude', action: 'file-sync', workspace: undefined, watch: false, argv: [],
  });
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', 'sync', '--watch', '--files'], {}), {
    command: 'claude', action: 'file-sync', workspace: 'chosen', watch: true, argv: [],
  });
  assert.equal(parseArguments(['claude', 'sync', '--help'], {}).command, 'help');
  for (const flags of [['--watch'], ['--files', '--files'], ['--files', '--watch', '--watch'], ['--files', '--to-workspace'], ['--files', '--from-workspace'], ['--files', '--include-uncommitted'], ['--files', '--force']]) {
    assert.throws(() => parseArguments(['claude', 'sync', ...flags], {}), /Usage/);
  }
  assert.match(HELP, /claude sync --files \[--watch\]/);
});

test('deletion is a Claude action and requires an explicit flag to bypass confirmation', () => {
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', 'delete', '--yes'], {}), {
    command: 'claude', action: 'delete', workspace: 'chosen', yes: true, argv: [],
  });
  assert.deepEqual(parseArguments(['claude', 'delete'], {}), {
    command: 'claude', action: 'delete', workspace: undefined, yes: false, argv: [],
  });
  for (const extra of [['--force'], ['--yes', '--yes'], ['other']]) {
    assert.throws(() => parseArguments(['claude', 'delete', ...extra], {}), /Usage: juiced claude delete/);
  }
  assert.throws(() => parseArguments(['delete'], {}), /Run juiced claude delete/);
});
