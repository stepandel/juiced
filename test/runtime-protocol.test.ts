import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createSessionRuntimeHandler } from '@cantelop/sdk/runtime';
import { createClient } from '@libsql/client';
import type { WorkspaceDatabase } from '@cantelop/sdk/session';
import { activateTerminal, receiveTerminal } from '../src/runtime/terminal.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from '../src/protocol.js';
import { discoverRepository, git, sha256 } from '../src/git.js';

test('durable agent routes run through the real SDK activity and native JSON process without client heartbeats', { timeout: 15_000 }, async t => {
  const previousDirectory = process.cwd();
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'juiced-durable-runtime-')));
  process.chdir(workspace);
  const sandboxId = `sbx-${'4'.repeat(32)}`;
  const server = createServer(createSessionRuntimeHandler({ onActivate: activateTerminal, receive: receiveTerminal }, { sandboxId, env: { CLAUDE_PATH: process.execPath } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { 'X-Cantelop-Sandbox-ID': sandboxId, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  };
  let cursor = 0;
  const events: TerminalEvent[] = [];
  const drain = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const batch = await request(`/__cantelop/v2/runtime/events?after=${cursor}&wait=0`);
      for (const item of batch.events) { if (item.event) events.push(item.event); cursor = item.cursor; }
      if (batch.events.length) await request('/__cantelop/v2/runtime/events/ack', { through: cursor });
      if (check()) return;
      await delay(5);
    }
    throw new Error('Durable runtime output did not arrive');
  };
  t.after(async () => {
    const status = await request('/__cantelop/v2/runtime').catch(() => ({}));
    if (status.activity) await request('/__cantelop/v2/runtime/activity/cancel', { activity_id: status.activity.id }).catch(() => {});
    // A cancelled writer can retain an already-published projection until acknowledgment.
    await drain(() => true).catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    process.chdir(previousDirectory); await rm(workspace, { recursive: true, force: true });
  });
  const submit = async (payload: TerminalCommand): Promise<TerminalReply> => {
    const id = `msg_${randomUUID().replaceAll('-', '')}`;
    await request('/__cantelop/v2/messages', { session: { id: 'durable-test', workspace_id: `wsp_${'2'.repeat(32)}`, keep_alive_seconds: 120 }, message: { id, payload }, reply: true });
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await request(`/__cantelop/v2/messages/${id}`);
      if (status.state === 'succeeded') return (await request(`/__cantelop/v2/messages/${id}/reply`)).reply;
      assert.notEqual(status.state, 'failed'); await delay(5);
    }
    throw Error('Durable command did not settle');
  };
  const fixture = `
    const fs = require('node:fs'), path = require('node:path');
    const send = value => console.log(JSON.stringify(value));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const frame = JSON.parse(line);
      if (frame.type === 'control_request') send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[],models:[]}}});
      if (frame.type === 'user') {
        const directory = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
        fs.mkdirSync(directory,{recursive:true}); fs.writeFileSync(path.join(directory,process.argv.at(-1)+'.jsonl'),'checkpoint');
        send(frame);
        setTimeout(()=>{send({type:'assistant',message:{id:'answer',content:[{type:'text',text:'DURABLE_NATIVE_OK'}]}});send({type:'result',result:'DURABLE_NATIVE_OK'});},25);
      }
    });`;
  const opened = await submit({ type: 'start', durable: true, tty: false, argv: ['-e', fixture, '--'], columns: 80, rows: 24, term: 'dumb' });
  assert.ok(opened.ok && opened.agent);
  const epoch = opened.ok ? opened.agent!.epoch : '';
  const send = (frame: Record<string, unknown>) => submit({ type: 'agent-input', id: randomUUID(), epoch, frame });
  await send({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize', hooks: null } });
  await send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Work without my connection' } });
  await drain(() => events.some(event => event.type === 'agent-output'));
  let recovered = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = await submit({ type: 'agent-replay', after: 0 });
    assert.ok(page.ok && page.replay);
    recovered = page.replay.entries.map(entry => entry.event.type === 'bytes' ? Buffer.from(entry.event.data, 'base64').toString() : '').join('');
    if (recovered.includes('DURABLE_NATIVE_OK') && recovered.includes('"type":"result"')) break;
    await drain(() => true); await delay(5);
  }
  assert.match(recovered, /DURABLE_NATIVE_OK/);
  assert.match(recovered, /"type":"result"/);
  const status = await request('/__cantelop/v2/runtime');
  assert.ok(Date.parse(status.activity.deadline) - Date.now() > 23 * 60 * 60 * 1000);
  const replay = await submit({ type: 'agent-replay', after: 0 });
  assert.ok(replay.ok && replay.replay?.entries.some(entry => entry.event.type === 'user'));
});

test('native runtime keeps terminal work alive after start intake and handles input, heartbeat, output acknowledgments and exit', { timeout: 10_000 }, async t => {
  const previousDirectory = process.cwd();
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'juiced-native-test-')));
  process.chdir(workspace);
  const sandboxId = `sbx-${'1'.repeat(32)}`;
  const server = createServer(createSessionRuntimeHandler({ onActivate: activateTerminal, receive: receiveTerminal }, { sandboxId, env: { CLAUDE_PATH: process.execPath } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, { headers: { 'X-Cantelop-Sandbox-ID': sandboxId, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok, `${path} returned ${response.status}: ${response.ok ? '' : await response.text()}`);
    return response.json();
  };
  t.after(async () => {
    const snapshot = await request('/__cantelop/v2/runtime').catch(() => ({}));
    if (snapshot.activity) await request('/__cantelop/v2/runtime/activity/cancel', { activity_id: snapshot.activity.id }).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.chdir(previousDirectory);
    await rm(workspace, { recursive: true, force: true });
  });
  const submit = async (payload: TerminalCommand, expected: TerminalReply = { ok: true }) => {
    const id = `msg_${randomUUID().replaceAll('-', '')}`;
    await request('/__cantelop/v2/messages', { session: { id: 'test', workspace_id: `wsp_${'2'.repeat(32)}`, keep_alive_seconds: 120 }, message: { id, payload }, reply: true });
    for (let i = 0; i < 100; i++) {
      const status = await request(`/__cantelop/v2/messages/${id}`);
      if (status.state === 'succeeded') {
        assert.deepEqual(await request(`/__cantelop/v2/messages/${id}/reply`), { reply: expected });
        return;
      }
      assert.notEqual(status.state, 'failed', JSON.stringify(status));
      await delay(5);
    }
    throw new Error('Message did not finish');
  };
  const events: TerminalEvent[] = [];
  let cursor = 0;
  const drainUntil = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      const batch = await request(`/__cantelop/v2/runtime/events?after=${cursor}&wait=0`);
      for (const item of batch.events) { events.push(item.event); cursor = item.cursor; }
      if (batch.events.length) await request('/__cantelop/v2/runtime/events/ack', { through: cursor });
      if (predicate()) return;
      await delay(5);
    }
    throw new Error('Expected terminal output did not arrive');
  };
  await submit({ type: 'start', tty: false, columns: 80, rows: 24, term: 'xterm-256color', argv: ['-e', `console.log('READY'); process.stdin.pipe(process.stdout); process.stdin.on('end',()=>process.exitCode=4);`] });
  await drainUntil(() => events.some(event => event.type === 'output'));
  await submit({ type: 'save-settings', settings: { model: 'sonnet', permissionMode: 'plan' } });
  assert.deepEqual(JSON.parse(await readFile(join(workspace, '.claude', 'settings.json'), 'utf8')), { model: 'sonnet', permissions: { defaultMode: 'plan' } });
  await submit({ type: 'save-settings', settings: { model: 'invalid model' } }, { ok: false, error: 'Invalid saved settings' });
  const first = await request('/__cantelop/v2/runtime');
  assert.ok(first.activity);
  await delay(10);
  await submit({ type: 'heartbeat' });
  const renewed = await request('/__cantelop/v2/runtime');
  assert.ok(Date.parse(renewed.activity.deadline) > Date.parse(first.activity.deadline));
  await submit({ type: 'input', data: Buffer.from('native intake 🍈\n').toString('base64') });
  await submit({ type: 'eof' });
  await drainUntil(() => events.some(event => event.type === 'exit'));
  const text = events.filter(event => event.type === 'output').map(event => Buffer.from(event.data, 'base64').toString()).join('');
  assert.match(text, /native intake 🍈/);
  assert.deepEqual(events.at(-1), { type: 'exit', code: 4 });
});

test('native runtime routes Git maintenance without starting Claude and returns actionable errors', { timeout: 10_000 }, async t => {
  const previous = process.cwd();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-git-native-')));
  const db = createClient({ url: `file:${join(root, 'db')}` });
  process.chdir(root);
  const sandboxId = `sbx-${'3'.repeat(32)}`;
  const server = createServer(createSessionRuntimeHandler<TerminalCommand, TerminalEvent, TerminalReply>({
    onActivate(context) { activateTerminal({ ...context, database: async () => db as WorkspaceDatabase }); },
    receive(context) { return receiveTerminal({ ...context, database: async () => db as WorkspaceDatabase }); },
  }, { sandboxId }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); process.chdir(previous); db.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, { headers: { 'X-Cantelop-Sandbox-ID': sandboxId, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    assert.ok(response.ok); return response.json();
  };
  const call = async (payload: TerminalCommand) => {
    const id = `msg_${randomUUID().replaceAll('-', '')}`;
    await request('/__cantelop/v2/messages', { session: { id: 'git-test', workspace_id: `wsp_${'4'.repeat(32)}`, keep_alive_seconds: 120 }, message: { id, payload }, reply: true });
    for (let i = 0; i < 100; i++) {
      const state = await request(`/__cantelop/v2/messages/${id}`);
      if (state.state === 'succeeded') return (await request(`/__cantelop/v2/messages/${id}/reply`)).reply;
      assert.notEqual(state.state, 'failed', JSON.stringify(state)); await delay(5);
    }
    throw new Error('Git command timed out');
  };
  const base = { type: 'git' as const, directoryName: 'project', binding: 'a'.repeat(64) };
  assert.deepEqual(await call({ ...base, action: 'status' }), { ok: true, git: { status: { initialized: false } } });
  assert.deepEqual(await call({ ...base, action: 'export', id: randomUUID(), known: 'b'.repeat(40) }), { ok: false, error: 'Initialize or recover this Git workspace before importing commits.' });
  assert.equal((await request('/__cantelop/v2/runtime')).activity, null);
});

test('native runtime streams a Git inspection without database access or starting Claude', { timeout: 15_000 }, async t => {
  const previous = process.cwd();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-inspect-native-'))), target = join(root, 'project');
  await mkdir(target); await git(target, ['init', '-b', 'main']);
  await git(target, ['config', 'user.name', 'Native Test']); await git(target, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(target, 'file.txt'), 'base\n'); await git(target, ['add', '.']); await git(target, ['commit', '-m', 'base']);
  const repository = (await discoverRepository(target))!;
  await mkdir(join(root, '.juiced', 'project'), { recursive: true });
  await writeFile(join(root, '.juiced', 'project', 'binding.json'), JSON.stringify({ version: 1, binding: repository.binding, sourceBranch: 'main' }));
  const index = await readFile(join(target, '.git', 'index'));
  process.chdir(root);
  const sandboxId = `sbx-${'5'.repeat(32)}`;
  const noDatabase = async (): Promise<WorkspaceDatabase> => { throw new Error('Inspection must not access the database'); };
  const server = createServer(createSessionRuntimeHandler<TerminalCommand, TerminalEvent, TerminalReply>({
    onActivate(context) { activateTerminal({ ...context, database: noDatabase }); },
    receive(context) { return receiveTerminal({ ...context, database: noDatabase }); },
  }, { sandboxId, env: { CLAUDE_PATH: '/missing-provider-binary' } }));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); process.chdir(previous); await rm(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { 'X-Cantelop-Sandbox-ID': sandboxId, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok); return response.json();
  };
  const message = `msg_${randomUUID().replaceAll('-', '')}`, inspection = randomUUID();
  await request('/__cantelop/v2/messages', { session: { id: 'inspection-test', workspace_id: `wsp_${'6'.repeat(32)}`, keep_alive_seconds: 120 }, message: { id: message, payload: { type: 'inspect', id: inspection, directoryName: 'project', binding: repository.binding, scope: '', includeIgnored: false } }, reply: true });
  const listingMessage = `msg_${randomUUID().replaceAll('-', '')}`, listing = randomUUID();
  const errorMessage = `msg_${randomUUID().replaceAll('-', '')}`, failed = randomUUID();
  for (const [id, payload] of [[listingMessage, { type: 'inspect', id: listing, directoryName: 'project', binding: repository.binding, scope: '', includeIgnored: false, mode: 'listing' }], [errorMessage, { type: 'inspect', id: failed, directoryName: 'project', binding: '0'.repeat(64), scope: '', includeIgnored: false }]] as const) {
    await request('/__cantelop/v2/messages', { session: { id: 'inspection-test', workspace_id: `wsp_${'6'.repeat(32)}`, keep_alive_seconds: 120 }, message: { id, payload }, reply: true });
  }
  const events: TerminalEvent[] = []; let cursor = 0, projections = 0;
  for (let i = 0; i < 300 && projections < 3; i++) {
    const batch = await request(`/__cantelop/v2/runtime/events?after=${cursor}&wait=0`);
    for (const item of batch.events) {
      if (item.view) { assert.deepEqual(item.view, { inspection: 1 }); projections++; }
      else events.push(item.event);
      cursor = item.cursor;
    }
    if (batch.events.length) await request('/__cantelop/v2/runtime/events/ack', { through: cursor });
    await delay(5);
  }
  assert.deepEqual(await request(`/__cantelop/v2/messages/${message}/reply`), { reply: { ok: true } });
  for (const id of [message, listingMessage, errorMessage]) assert.deepEqual(await request(`/__cantelop/v2/messages/${id}/reply`), { reply: { ok: true } });
  assert.equal(projections, 3);
  assert.equal((await request('/__cantelop/v2/runtime')).activity, null);
  const chunks = events.filter(event => event.type === 'inspection-chunk');
  const bytes = Buffer.concat(chunks.filter(event => event.id === inspection).map(event => Buffer.from(event.data, 'base64')));
  assert.deepEqual(events.find(event => event.type === 'inspection-end' && event.id === inspection), { type: 'inspection-end', id: inspection, size: bytes.length, sha256: sha256(bytes) });
  assert.equal(JSON.parse(bytes.toString()).entries[0].name, 'file.txt');
  const listed = Buffer.concat(chunks.filter(event => event.id === listing).map(event => Buffer.from(event.data, 'base64')));
  assert.deepEqual(JSON.parse(listed.toString()).entries, [{ name: 'file.txt', mode: '100644' }]);
  assert.ok(events.some(event => event.type === 'inspection-error' && event.id === failed));
  assert.deepEqual(await readFile(join(target, '.git', 'index')), index);
});
