import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { agentSessionId, prepareAgentSession } from '../src/session-state.js';
import { terminalIdentity, usesTerminalSession } from '../src/terminal-session.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'juiced-terminal-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project: { localDirectory: root, workspace: 'project' }, terminal: { identity: 'tab-a', workspaceId: 'workspace-a' } };
}

test('terminal identity distinguishes tabs, multiplexed panes, and shell lifetimes', async () => {
  const unavailable = async (): Promise<string> => { throw new Error('ps unavailable'); };
  assert.notEqual(await terminalIdentity({ TERM_SESSION_ID: 'tab-a' }, unavailable), await terminalIdentity({ TERM_SESSION_ID: 'tab-b' }, unavailable));
  assert.equal(await terminalIdentity({ ITERM_SESSION_ID: 'iterm-tab' }, unavailable), 'ITERM_SESSION_ID:iterm-tab');
  assert.equal(await terminalIdentity({ WT_SESSION: 'windows-tab' }, unavailable), 'WT_SESSION:windows-tab');
  const outer = { TERM_SESSION_ID: 'outer', TMUX: '/tmp/tmux,123,0' };
  assert.notEqual(await terminalIdentity({ ...outer, TMUX_PANE: '%1' }), await terminalIdentity({ ...outer, TMUX_PANE: '%2' }));
  assert.notEqual(await terminalIdentity({ STY: '123.screen', WINDOW: '0' }), await terminalIdentity({ STY: '123.screen', WINDOW: '1' }));
  assert.notEqual(await terminalIdentity({}, async () => '123:Monday'), await terminalIdentity({}, async () => '123:Tuesday'));
  assert.equal(await terminalIdentity({}, unavailable), undefined);
  assert.equal(await terminalIdentity({}, async () => ''), undefined);
});

test('explicit Claude session selection and disabled persistence bypass the binding', () => {
  assert.equal(usesTerminalSession([]), true);
  assert.equal(usesTerminalSession(['--model', 'sonnet']), true);
  for (const argv of [['--resume', 'id'], ['--resume=name'], ['-r', 'id'], ['-rname'], ['--continue'], ['-c'], ['--session-id', 'id'], ['--fork-session'], ['--from-pr', '12'], ['--teleport', 'id'], ['--no-session-persistence']]) {
    assert.equal(usesTerminalSession(argv), false, JSON.stringify(argv));
  }
  assert.equal(usesTerminalSession(['--', '--resume']), true);
  assert.throws(() => usesTerminalSession(['--resume', 'id'], true), /cannot be combined/);
});

test('subsequent launches reuse the terminal session and keep explicit last-session recovery working', async t => {
  const f = await fixture(t);
  const first = await prepareAgentSession(f.project, { terminal: f.terminal });
  assert.equal(first.resumed, false); await first.save();
  const next = await prepareAgentSession(f.project, { terminal: f.terminal });
  assert.equal(next.id, first.id); assert.equal(next.resumed, true); await next.save();
  assert.equal(await agentSessionId(f.project, true), first.id);
  const directory = join(f.root, '.cantelop', 'juiced');
  const files = await readdir(directory); assert.equal(files.length, 2);
  for (const file of files) {
    assert.deepEqual(JSON.parse(await readFile(join(directory, file), 'utf8')), { workspace: 'project', id: first.id });
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('other tabs, projects, workspace overrides, and recreated workspaces start separate sessions', async t => {
  const f = await fixture(t);
  const first = await prepareAgentSession(f.project, { terminal: f.terminal }); await first.save();
  for (const terminal of [{ ...f.terminal, identity: 'tab-b' }, { ...f.terminal, workspaceId: 'workspace-recreated' }]) {
    const next = await prepareAgentSession(f.project, { terminal });
    assert.notEqual(next.id, first.id); assert.equal(next.resumed, false); await next.save();
  }
  for (const project of [{ ...f.project, localDirectory: join(f.root, 'other-project') }, { ...f.project, workspace: 'override' }]) {
    const next = await prepareAgentSession(project, { terminal: f.terminal });
    assert.notEqual(next.id, first.id); assert.equal(next.resumed, false); await next.save();
  }
  const original = await prepareAgentSession(f.project, { terminal: f.terminal });
  assert.equal(original.id, first.id); assert.equal(original.resumed, true);
});

test('--new replaces the current terminal binding without disturbing another tab', async t => {
  const f = await fixture(t);
  const first = await prepareAgentSession(f.project, { terminal: f.terminal }); await first.save();
  const otherTab = { ...f.terminal, identity: 'tab-b' };
  const other = await prepareAgentSession(f.project, { terminal: otherTab }); await other.save();
  const fresh = await prepareAgentSession(f.project, { terminal: f.terminal, fresh: true });
  assert.notEqual(fresh.id, first.id); assert.equal(fresh.resumed, false); await fresh.save();
  assert.equal((await prepareAgentSession(f.project, { terminal: f.terminal })).id, fresh.id);
  assert.equal((await prepareAgentSession(f.project, { terminal: otherTab })).id, other.id);
});

test('failed launch preparation cannot leave a saved terminal binding', async t => {
  const f = await fixture(t);
  const unsaved = await prepareAgentSession(f.project, { terminal: f.terminal });
  const retry = await prepareAgentSession(f.project, { terminal: f.terminal });
  assert.notEqual(retry.id, unsaved.id); assert.equal(retry.resumed, false);
  await retry.save();
  assert.equal((await prepareAgentSession(f.project, { terminal: f.terminal })).id, retry.id);
});

test('explicit recovery bypasses the terminal binding and ordinary non-bound launches remain fresh', async t => {
  const f = await fixture(t);
  const first = await prepareAgentSession(f.project, { terminal: f.terminal }); await first.save();
  const explicit = `ses_${'1'.repeat(32)}`;
  assert.equal(await agentSessionId(f.project, true, explicit), explicit);
  assert.equal((await prepareAgentSession(f.project, { terminal: f.terminal })).id, first.id);
  assert.notEqual(await agentSessionId(f.project), explicit);
  await assert.rejects(prepareAgentSession(f.project, { fresh: true, resume: true }), /cannot be combined/);
  await assert.rejects(agentSessionId(f.project, false, ''), /Invalid/);
});

test('corrupt saved identities fail explicitly and --new repairs the binding', async t => {
  const f = await fixture(t);
  const first = await prepareAgentSession(f.project, { terminal: f.terminal }); await first.save();
  const directory = join(f.root, '.cantelop', 'juiced');
  for (const file of await readdir(directory)) await writeFile(join(directory, file), JSON.stringify({ workspace: 'project', id: '../unsafe' }));
  await assert.rejects(prepareAgentSession(f.project, { terminal: f.terminal }), /Invalid saved/);
  const fresh = await prepareAgentSession(f.project, { terminal: f.terminal, fresh: true }); await fresh.save();
  assert.equal((await prepareAgentSession(f.project, { terminal: f.terminal })).id, fresh.id);
  const blocked = { ...f.project, localDirectory: join(f.root, 'blocked') }; await mkdir(blocked.localDirectory);
  await writeFile(join(blocked.localDirectory, '.cantelop'), 'not a directory');
  const failed = await prepareAgentSession(blocked, { terminal: f.terminal, fresh: true });
  await assert.rejects(failed.save());
});
