import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CantelopClient, type AppCommandEnvelope } from '@cantelop/sdk';
import { listSessions } from '../src/list-sessions.js';
import { parseArguments, HELP } from '../src/args.js';
import { prepareAgentSession } from '../src/session-state.js';
import { SESSION_PAGE_SIZE, validateSessionListPage, type SessionListCommand } from '../src/session-list-protocol.js';
import { AgentJournal } from '../src/runtime/agent-journal.js';
import { listRemoteSessions, sessionKey } from '../src/runtime/session-list.js';
import { receiveTerminal } from '../src/runtime/terminal.js';
import { discoverRepository, git } from '../src/git.js';
import { selectProject } from '../src/project.js';
import type { SessionContext } from '@cantelop/sdk/session';
import type { TerminalCommand, TerminalEvent, TerminalReply } from '../src/protocol.js';

const id = (n: number) => `ses_${n.toString(16).padStart(32, '0')}`;
const signal = () => new AbortController().signal;
const start = (directoryName: string, git?: { binding: string; relativeDirectory: string }): Extract<TerminalCommand, { type: 'start' }> => ({ type: 'start', argv: [], durable: true, tty: false, columns: 80, rows: 24, term: 'dumb', directoryName, ...(git ? { git } : {}) });

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'juiced-sessions-'));
  const local = join(root, 'project'), remote = join(root, 'remote');
  await mkdir(local); await mkdir(remote);
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = async (n: number, options: { directoryName?: string; git?: { binding: string; relativeDirectory: string }; legacy?: boolean; updatedAt?: string } = {}) => {
    const journal = new AgentJournal(remote, id(n)); await journal.open();
    await journal.configure(start(options.directoryName ?? 'project', options.git));
    await journal.setConversation(`native-${n}`); await journal.event({ type: 'state', state: 'sleeping' }); await journal.close();
    const directory = join(remote, '.juiced', 'sessions', sessionKey(id(n)));
    if (options.legacy) await rm(join(directory, 'identity.json'));
    if (options.updatedAt) await utimes(join(directory, 'events.jsonl'), new Date(options.updatedAt), new Date(options.updatedAt));
    return directory;
  };
  return { root, local, remote, history };
}

test('sessions is a workspace-scoped command with literal prompt escaping and no session-selection conflict', () => {
  assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', 'sessions'], {}), { command: 'claude', action: 'sessions', workspace: 'chosen', argv: [] });
  assert.deepEqual(parseArguments(['claude', '--', 'sessions'], {}), { command: 'claude', action: 'run', workspace: undefined, argv: ['sessions'] });
  assert.equal(parseArguments(['claude', 'sessions', '--help'], {}).command, 'help');
  assert.throws(() => parseArguments(['claude', 'sessions', 'extra'], {}), /Usage: juiced claude sessions/);
  assert.throws(() => parseArguments(['claude', '--session', id(1), 'sessions'], {}), /interactive/);
  assert.match(HELP, /juiced \[--workspace SLUG\] claude sessions/);
});

test('remote listing includes histories without local bindings, filters project checkouts, and leaves histories untouched', async t => {
  const f = await fixture(t);
  const first = await f.history(1), second = await f.history(2);
  await f.history(3, { directoryName: 'other-project' });
  const gitContext = { binding: 'a'.repeat(64), relativeDirectory: 'nested' };
  await f.history(4, { git: gitContext });
  await f.history(5, { git: { ...gitContext, relativeDirectory: '' } });
  const before = await readFile(join(first, 'events.jsonl'));
  const listed = await listRemoteSessions({ type: 'sessions-list', directoryName: 'project' }, signal(), f.remote);
  assert.deepEqual(new Set(listed.items.map(item => item.id)), new Set([id(1), id(2)]));
  assert.deepEqual(await readFile(join(first, 'events.jsonl')), before);
  assert.deepEqual((await readdir(first)).sort(), ['events.jsonl', 'identity.json']);
  assert.deepEqual((await readdir(second)).sort(), ['events.jsonl', 'identity.json']);
  const gitList = await listRemoteSessions({ type: 'sessions-list', directoryName: 'project', git: gitContext }, signal(), f.remote);
  assert.deepEqual(gitList.items.map(item => item.id), [id(4)]);
  assert.equal((await stat(join(first, 'identity.json'))).mode & 0o777, 0o600);
});

test('pagination crosses empty filtered pages and stays within the reply limit', async t => {
  const f = await fixture(t);
  const ordered = Array.from({ length: SESSION_PAGE_SIZE + 3 }, (_, n) => n).sort((a, b) => sessionKey(id(a)).localeCompare(sessionKey(id(b))));
  const matching = new Set(ordered.slice(SESSION_PAGE_SIZE));
  for (const n of ordered) await f.history(n, { directoryName: matching.has(n) ? 'project' : 'other-project' });
  let after: string | undefined, pages = 0;
  const ids: string[] = [];
  do {
    const page = await listRemoteSessions({ type: 'sessions-list', directoryName: 'project', ...(after ? { after } : {}) }, signal(), f.remote);
    validateSessionListPage(page, after);
    if (!pages) { assert.equal(page.items.length, 0); assert.ok(page.after); }
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
    ids.push(...page.items.map(item => item.id!)); after = page.after; pages++;
  } while (after);
  assert.equal(pages, 2);
  assert.deepEqual(new Set(ids), new Set([...matching].map(id)));
});

test('legacy IDs are restored on reattachment and unknown, corrupt, and unsafe histories are handled explicitly', async t => {
  const f = await fixture(t);
  const legacy = await f.history(1, { legacy: true });
  const corrupt = await f.history(2); await writeFile(join(corrupt, 'events.jsonl'), '{broken}\n');
  const forged = await f.history(3); await writeFile(join(forged, 'identity.json'), JSON.stringify({ version: 1, id: id(4) }));
  await symlink(legacy, join(f.remote, '.juiced', 'sessions', sessionKey(id(9))));
  const command: SessionListCommand = { type: 'sessions-list', directoryName: 'project' };
  const page = await listRemoteSessions(command, signal(), f.remote);
  assert.equal(page.unreadable, 1);
  assert.equal(page.items.length, 2); assert.ok(page.items.every(item => item.id === undefined));
  const journal = new AgentJournal(f.remote, id(1)); await journal.open(); await journal.close();
  const again = await listRemoteSessions(command, signal(), f.remote);
  assert.equal(again.items.find(item => item.key === sessionKey(id(1)))?.id, id(1));
  await assert.rejects(listRemoteSessions({ ...command, directoryName: '../other' }, signal(), f.remote), /Invalid/);
  await assert.rejects(listRemoteSessions(command, AbortSignal.abort(), f.remote), /abort/i);
});

test('session list validation rejects repeated cursors, duplicates, and terminal control data', () => {
  const item = { key: sessionKey(id(1)), id: id(1), updatedAt: new Date().toISOString() };
  assert.deepEqual(validateSessionListPage({ items: [item], unreadable: 0 }).items, [item]);
  for (const page of [{ items: [item, item], unreadable: 0 }, { items: [{ ...item, id: '\x1b[2J' }], unreadable: 0 }, { items: [item], unreadable: -1 }]) {
    assert.throws(() => validateSessionListPage(page), /invalid session list/);
  }
  assert.throws(() => validateSessionListPage({ items: [], unreadable: 0, after: item.key }, item.key), /invalid session list/);
});

test('real SDK listing uses an existing canonical workspace, includes legacy local IDs, and never starts Claude', async t => {
  const f = await fixture(t), project = await selectProject(f.local, 'chosen');
  const first = await f.history(1, { updatedAt: '2026-10-19T12:00:00Z' });
  await f.history(2, { legacy: true, updatedAt: '2026-10-20T12:00:00Z' }); await f.history(3, { legacy: true });
  const binding = await prepareAgentSession(project, { terminal: { identity: 'legacy-tab', workspaceId: 'old-workspace' } }); await binding.save();
  const pointers = join(f.local, '.cantelop', 'juiced');
  const pointer = join(pointers, (await readdir(pointers))[0]!);
  await writeFile(pointer, JSON.stringify({ workspace: 'chosen', id: id(2) }));
  const historyBefore = await readFile(join(first, 'events.jsonl')), pointerBefore = await readFile(pointer);
  const workspaceId = `wsp_${'a'.repeat(32)}`, calls: AppCommandEnvelope<TerminalCommand>[] = [];
  let exists = false, failNextPage = false;
  const app = new CantelopClient().app<TerminalCommand, TerminalEvent, TerminalReply>({ name: 'sessions-test', runtime: { receive() {} }, connection: { async fetch(request) {
    const body = await request.json() as AppCommandEnvelope<TerminalCommand>; calls.push(body);
    if (body.command.type === 'workspace.inspect') return Response.json({ protocolVersion: 2, workspace: exists ? { id: workspaceId, slug: 'chosen', app_id: `app_${'b'.repeat(32)}`, hostname: 'fixture.cantelop.dev', created_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null });
    assert.deepEqual(body.workspace, { id: workspaceId });
    if (body.command.type === 'stop') return Response.json({ protocolVersion: 2, id: body.id });
    assert.equal(body.command.type, 'request');
    if (body.command.type !== 'request') throw new Error('Unexpected operation');
    assert.equal(body.command.keepAliveSeconds, 0); assert.equal(body.command.message.type, 'sessions-list');
    if (failNextPage && (body.command.message as SessionListCommand).after) return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: false, error: 'Listing interrupted' } });
    const sessions = await listRemoteSessions(body.command.message as SessionListCommand, request.signal, f.remote);
    if (failNextPage) sessions.after = sessions.items.at(-1)!.key;
    return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true, sessions } });
  } } });
  const stdout = new PassThrough(); let output = ''; stdout.on('data', bytes => output += String(bytes));
  await listSessions(app, f.local, 'chosen', signal(), stdout);
  assert.match(output, /does not exist/); assert.deepEqual(calls.map(call => call.command.type), ['workspace.inspect']);
  exists = true; calls.length = 0; output = '';
  await listSessions(app, f.local, 'chosen', signal(), stdout);
  assert.ok(output.indexOf(id(2)) < output.indexOf(id(1)), 'Newest sessions should appear first');
  assert.match(output, /1 older history has no saved Juiced ID/);
  assert.match(output, /Reopen: juiced --workspace chosen claude --session ID/);
  assert.deepEqual(calls.map(call => call.command.type), ['workspace.inspect', 'request', 'stop']);
  assert.deepEqual(await readFile(join(first, 'events.jsonl')), historyBefore);
  assert.deepEqual(await readFile(pointer), pointerBefore);
  assert.deepEqual((await readdir(pointers)).length, 1);
  output = ''; failNextPage = true;
  await assert.rejects(listSessions(app, f.local, 'chosen', signal(), stdout), /Listing interrupted/);
  assert.equal(output, '', 'An interrupted list must not print a partial success');
  assert.equal(calls.at(-1)!.command.type, 'stop');
});

test('session listing waits through a finishing session keep-alive before reading histories', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  // AbortSignal's native timer is outside MockTimers; drive its deadline with the test clock too.
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Listing timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  const workspaceId = `wsp_${'a'.repeat(32)}`;
  let requests = 0, stopped = false, waited = 0, notify!: () => void;
  const waiting = new Promise<void>(resolve => { notify = resolve; });
  const app = new CantelopClient().app<TerminalCommand, TerminalEvent, TerminalReply>({ name: 'sessions-admission-test', runtime: { receive() {} }, connection: { async fetch(request) {
    const body = await request.json() as AppCommandEnvelope<TerminalCommand>;
    if (body.command.type === 'workspace.inspect') return Response.json({ protocolVersion: 2, workspace: { id: workspaceId, slug: 'chosen', app_id: `app_${'b'.repeat(32)}`, hostname: 'fixture.cantelop.dev', created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    if (body.command.type === 'stop') { stopped = true; return Response.json({ protocolVersion: 2, id: body.id }); }
    assert.equal(body.command.type, 'request');
    if (++requests === 1) {
      t.mock.timers.tick(120_000);
      request.signal.throwIfAborted();
      return Response.json({ error: { code: 'session_admission_timeout' } }, { status: 409 });
    }
    request.signal.throwIfAborted();
    return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true, sessions: { items: [{ key: sessionKey(id(1)), id: id(1), updatedAt: new Date().toISOString() }], unreadable: 0 } } });
  } } });
  const stdout = new PassThrough(); let output = ''; stdout.on('data', bytes => output += String(bytes));
  const listed = listSessions(app, f.local, 'chosen', signal(), stdout, () => { waited++; notify(); });
  // Fail promptly if the old 60-second deadline fires instead of reaching the retry.
  await Promise.race([waiting, listed.then(() => assert.fail('Expected an admission retry'))]);
  t.mock.timers.tick(1000);
  await listed;
  assert.equal(requests, 2);
  assert.equal(waited, 1);
  assert.equal(stopped, true);
  assert.match(output, new RegExp(id(1)));
});

test('Git-aware listing matches the exact binding and relative launch directory', async t => {
  const f = await fixture(t); await git(f.local, ['init']);
  await git(f.local, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial']);
  const repository = (await discoverRepository(f.local))!;
  const command: SessionListCommand = { type: 'sessions-list', directoryName: 'project', git: { binding: repository.binding, relativeDirectory: repository.relativeDirectory } };
  await f.history(1, { git: command.git! });
  assert.deepEqual((await listRemoteSessions(command, signal(), f.remote)).items.map(item => item.id), [id(1)]);
});

test('session-list read failures stay distinct from empty history and expired cleanup sessions', async t => {
  const f = await fixture(t);
  for (const scenario of [
    { read: undefined, stop: 'session_not_found' },
    { read: 'session_not_found', stop: 'session_not_found' },
    { read: 'permission_denied', stop: 'session_not_found' },
    { read: 'session_not_found', stop: 'cleanup_failed' },
  ]) {
    const calls: string[] = [];
    const app = new CantelopClient().app<TerminalCommand, TerminalEvent, TerminalReply>({ name: 'sessions-errors', runtime: { receive() {} }, connection: { async fetch(request) {
      const body = await request.json() as AppCommandEnvelope<TerminalCommand>;
      calls.push(body.command.type);
      if (body.command.type === 'workspace.inspect') return Response.json({ protocolVersion: 2, workspace: {
        id: `wsp_${'a'.repeat(32)}`, slug: 'chosen', app_id: `app_${'b'.repeat(32)}`, hostname: 'fixture.cantelop.dev', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      } });
      const code = body.command.type === 'stop' ? scenario.stop : scenario.read;
      if (code) return Response.json({ error: { code } }, { status: 404 });
      return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true, sessions: { items: [], unreadable: 0 } } });
    } } });
    const stdout = new PassThrough(); let output = '';
    stdout.on('data', bytes => { output += String(bytes); });
    const listed = listSessions(app, f.local, 'chosen', signal(), stdout);
    if (!scenario.read) {
      await listed;
      assert.match(output, /No saved sessions/);
    } else {
      await assert.rejects(listed, error => {
        if (scenario.read === 'session_not_found') {
          assert.match((error as Error).message, /Saved conversations could not be read/);
          assert.match((error as Error).message, /juiced --workspace chosen claude sessions/);
          assert.match((error as Error).message, /juiced --workspace chosen claude login/);
          assert.equal(((error as Error).cause as { code: string }).code, 'session_not_found');
        } else assert.equal((error as { code: string }).code, 'permission_denied');
        return true;
      });
      assert.equal(output, '', 'A failed read must never look like an empty saved history');
    }
    assert.deepEqual(calls, ['workspace.inspect', 'request', 'stop']);
  }
});

test('runtime listing routes directly without activities, database access, or a native process', async t => {
  const f = await fixture(t);
  const original = process.cwd();
  process.chdir(f.remote);
  try {
    let reply: TerminalReply | undefined;
    await receiveTerminal({ message: { payload: { type: 'sessions-list', directoryName: 'project' } }, signal: signal(), reply(value) { reply = value; } } as SessionContext<TerminalCommand, TerminalEvent, TerminalReply>);
    assert.deepEqual(reply, { ok: true, sessions: { items: [], unreadable: 0 } });
    assert.deepEqual(await readdir(f.remote), []);
  } finally { process.chdir(original); }
  assert.equal(process.cwd(), original);
});
