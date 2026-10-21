import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { CantelopClient, type AppCommandEnvelope, type SessionEvent } from '@cantelop/sdk';
import type { WorkspaceDatabase } from '@cantelop/sdk/session';
import { discoverRepository, git, gitText } from '../src/git.js';
import { GitWorkspaceClient } from '../src/git-workspace.js';
import { LocalUploader } from '../src/local-upload.js';
import { PublicationBroker } from '../src/agent/publications.js';
import type { Approval } from '../src/agent-protocol.js';
import { acquireCheckout } from '../src/runtime/project-state.js';
import { LocalPublisher } from '../src/local-publish.js';
import { selectProject } from '../src/project.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from '../src/protocol.js';
import type { Publication, PublishResult, UploadRequest } from '../src/publish-protocol.js';
import { createGitRuntime } from '../src/runtime/git.js';
import { createPublishBridge } from '../src/runtime/publish.js';
import { createTerminal } from '../src/runtime/terminal.js';
import { until as poll } from './fixtures/wait.js';

const until = (check: () => boolean) => poll(check, { message: 'Publication did not arrive' });

async function fixture(t: test.TestContext, initialEdits = false, relativeDirectory?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-publish-')));
  const local = join(root, 'project'), remote = join(root, 'remote');
  await mkdir(local); await mkdir(remote);
  await git(local, ['init', '-b', 'main']);
  await git(local, ['config', 'user.name', 'Test']); await git(local, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(local, 'README.md'), 'base\n'); await writeFile(join(local, 'remove'), 'remove me\n');
  await writeFile(join(local, '.gitignore'), '.env\n');
  await git(local, ['add', '.']); await git(local, ['commit', '-m', 'base']);
  if (initialEdits) {
    await writeFile(join(local, 'README.md'), 'staged initial\n'); await git(local, ['add', 'README.md']);
    await writeFile(join(local, 'README.md'), 'unstaged initial\n');
  }
  const project = await selectProject(local), repository = (await discoverRepository(local))!;
  const lifetime = new AbortController(), events = new EventEmitter();
  const releases: Array<() => Promise<void>> = [];
  const db = createClient({ url: `file:${join(root, 'leases.db')}` });
  const context = (id: string) => ({ signal: lifetime.signal, session: { id, keepAliveSeconds: 120 }, env: {}, database: async () => db as WorkspaceDatabase });
  const histories = new Map<string, SessionEvent<TerminalEvent>[]>();
  const app = new CantelopClient().app<TerminalCommand, TerminalEvent, TerminalReply>({ name: 'publication-test', runtime: { receive() {} }, connection: { async fetch(request) {
    const envelope = await request.json() as AppCommandEnvelope<TerminalCommand>;
    const id = envelope.session!.id, operation = envelope.command;
    if (operation.type === 'request') {
      const command = operation.message;
      assert.equal(command.type, 'git'); if (command.type !== 'git') throw new Error('Expected Git maintenance');
      const runtime = createGitRuntime(context(id), remote);
      let reply: TerminalReply;
      try {
        if (command.action === 'download') {
          const history = histories.get(id) ?? []; histories.set(id, history);
          void runtime.handle(command, { async send(data) { history.push({ data, cursor: { streamId: 'a'.repeat(32), sequence: history.length + 1 }, sessionId: id, messageId: envelope.id, createdAt: new Date() }); events.emit(id); } }).catch(error => { throw error; });
          reply = { ok: true };
        } else reply = { ok: true, git: await runtime.handle(command) };
      } catch (error) { reply = { ok: false, error: (error as Error).message }; }
      return Response.json({ protocolVersion: 2, id: envelope.id, reply });
    }
    if (operation.type === 'stream') {
      let index = operation.after?.sequence ?? 0;
      const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]);
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (!histories.get(id)?.[index]) await once(events, id, { signal });
          const event = histories.get(id)![index++]!;
          controller.enqueue(new TextEncoder().encode(`id: ${event.cursor.streamId}:${event.cursor.sequence}\ndata: ${JSON.stringify({ stream_id: event.cursor.streamId, sequence: event.cursor.sequence, session_id: id, message_id: event.messageId, created_at: event.createdAt.toISOString(), data: event.data })}\n\n`));
        }, cancel() { abort.abort(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (operation.type === 'stop') return Response.json({ protocolVersion: 2, id: envelope.id });
    throw new Error(`Unexpected SDK operation ${operation.type}`);
  } } });
  const workspace = app.workspace({ slug: project.workspace });
  const client = new GitWorkspaceClient(workspace, project, repository, lifetime.signal);
  await client.send(initialEdits); await client.close();
  const offers: Publication[] = [], uploads: UploadRequest[] = [], completed: string[] = [];
  let broker: PublicationBroker | undefined;
  const bridge = await createPublishBridge(context('claude'), { workspace: remote, directoryName: project.directoryName, binding: repository.binding, known: repository.head, ...(relativeDirectory ? { relativeDirectory } : {}),
    async send(event) { if (event.type === 'local-publish') offers.push(event.publication); if (event.type === 'local-upload') { uploads.push(event.request); broker?.offer(event.request); } if (event.type === 'local-publish-done') { completed.push(event.id); broker?.done(event.id); } } });
  const config = JSON.parse(bridge.configuration).mcpServers['juiced-local'];
  const child = spawn(process.execPath, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  let diagnostic = '', next = 0;
  child.stderr.on('data', bytes => { diagnostic += bytes; });
  const waiting = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    const waiter = waiting.get(response.id); waiting.delete(response.id);
    if (response.error) waiter?.reject(new Error(response.error.message)); else waiter?.resolve(response.result);
  });
  const rpc = (method: string, params: unknown = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++next; waiting.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const publisher = new LocalPublisher(workspace, project, repository);
  const offer = async (kind: 'commits' | 'snapshot', extra = {}) => {
    const index = offers.length;
    const response = rpc('tools/call', { name: `publish_${kind}`, arguments: { summary: `Test ${kind} publication`, ...extra } });
    await until(() => offers.length > index);
    return { publication: offers[index]!, response };
  };
  const finish = async (publication: Publication, result: PublishResult, owner = randomUUID()) => {
    await bridge.input({ type: 'publish-claim', id: publication.id, client: owner });
    return bridge.input({ type: 'publish-result', id: publication.id, client: owner, result });
  };
  const uploader = new LocalUploader(workspace, project, repository);
  const attachUploader = () => {
    const approvals = new Map<string, Approval>(), frames: Record<string, unknown>[] = [];
    broker = new PublicationBroker({ approvals, signal: lifetime.signal, localPublish: { head: repository.head, apply: (publication, signal) => publisher.apply(publication, signal), upload: uploader },
      emit(event, ...args) { if (event === 'frame') frames.push(args[0] as Record<string, unknown>); return true; },
      async request(command) {
        if (command.type !== 'publish-status' && command.type !== 'publish-claim' && command.type !== 'publish-result') throw new Error('Expected publication control');
        const result = await bridge.input(command);
        return { ok: true, ...(result ? { publication: result } : {}) };
      } });
    return { broker, approvals, frames };
  };
  const pull = async (args: Record<string, unknown> = {}) => {
    const index = uploads.length;
    const response = rpc('tools/call', { name: 'pull_local_changes', arguments: { summary: 'Send my laptop edits here', ...args } });
    const requestId = next;
    await until(() => uploads.length > index);
    return { request: uploads[index]!, response, cancel: () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }) + '\n') };
  };
  t.after(async () => { child.stdin.end(); await bridge.close(); await broker?.settled(); for (const request of uploads) await uploader.discard(request.id); child.kill(); await exit; lines.close(); for (const release of releases) await release(); lifetime.abort(); db.close(); await rm(root, { recursive: true, force: true }); assert.equal(diagnostic, ''); });
  return { local, target: join(remote, project.directoryName), remote, root, repository, project, publisher, uploader, attachUploader, pull, uploads, offers, completed, bridge, rpc, offer, finish, context, releases, signal: lifetime.signal };
}

test('native terminal startup injects the MCP server and routes the claimed local result back to Claude', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, 'README.md'), 'through the native terminal\n');
  const terminal = createTerminal(f.context('native-claude'), { workspace: f.remote, binary: process.execPath });
  const received: TerminalEvent[] = [];
  const script = `
    const {spawn} = require('node:child_process');
    const {createInterface} = require('node:readline');
    const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers['juiced-local'];
    const mcp = spawn(process.execPath, config.args, {env:{...process.env,...config.env},stdio:['pipe','pipe','inherit']});
    const send = value => mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
    createInterface({input:mcp.stdout}).on('line', line => {
      const response = JSON.parse(line);
      if (response.id === 1) {
        send({method:'notifications/initialized'});
        send({id:2,method:'tools/call',params:{name:'publish_snapshot',arguments:{summary:'Native integration test'}}});
      }
      if (response.id === 2) {
        console.log(JSON.stringify({type:'result',result:response.result.content[0].text}));
        mcp.stdin.end();
      }
    });
    mcp.on('exit', code => process.exit(code));
    send({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'native-fixture',version:'1'}}});
  `;
  const running = terminal.run({ type: 'start', durable: true, localPublish: f.repository.head, argv: ['-e', script, '--'], tty: false, columns: 80, rows: 24, term: 'dumb', directoryName: f.project.directoryName, git: { binding: f.repository.binding, relativeDirectory: '' } }, { signal: f.signal, output: { async send(event) { received.push(event); } } });
  void running.catch(() => {});
  try {
    await until(() => received.some(event => event.type === 'local-publish'));
    const publication = (received.find(event => event.type === 'local-publish') as Extract<TerminalEvent, { type: 'local-publish' }>).publication;
    const client = randomUUID();
    await terminal.input({ type: 'publish-status', id: publication.id });
    await terminal.input({ type: 'publish-claim', id: publication.id, client });
    const result = await f.publisher.apply(publication, f.signal);
    await terminal.input({ type: 'publish-result', id: publication.id, client, result });
    await running;
    const output = received.filter(event => event.type === 'output' && event.channel === 'stdout').map(event => Buffer.from((event as Extract<TerminalEvent, { type: 'output' }>).data, 'base64').toString()).join('');
    assert.equal(JSON.parse(JSON.parse(output).result).status, 'applied');
    assert.equal(await readFile(join(f.local, 'README.md'), 'utf8'), 'through the native terminal\n');
    assert.ok(received.some(event => event.type === 'local-publish-done'));
  } finally { terminal.cancel(); await running.catch(() => {}); }
});

test('real stdio MCP publishes a pinned commit through SDK transfers and reports local completion', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.rpc('tools/list')).tools && ((await f.rpc('tools/list')).tools as Array<{ name: string }>).map(tool => tool.name), ['publish_commits', 'publish_snapshot', 'pull_local_changes']);
  await assert.rejects(f.rpc('tools/call', { name: 'publish_commits', arguments: { summary: 'bad path', path: '/another/repository' } }), /Invalid publication arguments/);
  await writeFile(join(f.target, 'result'), 'completed\n'); await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'agent result']);
  const head = await gitText(f.target, ['rev-parse', 'HEAD']);
  const { publication, response } = await f.offer('commits', { head });
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), f.repository.head, 'Offering a publication must not apply it');
  await writeFile(join(f.target, 'later'), 'next turn\n'); await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'later work']);
  const result = await f.publisher.apply(publication, f.signal);
  const owner = randomUUID();
  await f.finish(publication, result, owner);
  await f.bridge.input({ type: 'publish-result', id: publication.id, client: owner, result });
  await assert.rejects(f.bridge.input({ type: 'publish-result', id: publication.id, client: owner, result: { ...result, message: 'different result' } }), /Conflicting publication result/);
  assert.equal((await response).isError, false);
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), head);
  await assert.rejects(readFile(join(f.local, 'later')), /ENOENT/);
  assert.equal((await f.publisher.apply(publication, f.signal)).status, 'already-applied');
  await assert.rejects(f.bridge.input({ type: 'publish-claim', id: publication.id, client: randomUUID() }), /no longer pending/);
});

test('successive snapshots preserve initial uncommitted work, staging, binary bytes, symlinks and modes', { timeout: 30_000 }, async t => {
  const f = await fixture(t, true);
  const index = await readFile(join(f.local, '.git', 'index'));
  await writeFile(join(f.target, 'README.md'), 'unstaged initial\nagent edit\n');
  const binary = randomBytes(180_000), filename = 'new file\n🍈.bin';
  await writeFile(join(f.target, filename), binary);
  await rm(join(f.target, 'remove'));
  await writeFile(join(f.target, 'executable'), '#!/bin/sh\n'); await chmod(join(f.target, 'executable'), 0o755);
  await symlink('README.md', join(f.target, 'link'));
  await writeFile(join(f.local, '.env'), 'keep ignored local data');
  const first = await f.offer('snapshot');
  await f.finish(first.publication, await f.publisher.apply(first.publication, f.signal));
  assert.equal((await first.response).isError, false);
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), f.repository.head);
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), index);
  assert.deepEqual(await readFile(join(f.local, filename)), binary);
  assert.equal(await readlink(join(f.local, 'link')), 'README.md');
  assert.equal((await lstat(join(f.local, 'executable'))).mode & 0o111, 0o111);
  await assert.rejects(readFile(join(f.local, 'remove')), /ENOENT/);
  assert.equal(await readFile(join(f.local, '.env'), 'utf8'), 'keep ignored local data');
  await writeFile(join(f.target, 'README.md'), 'second publication\n');
  await writeFile(join(f.local, 'unrelated'), 'keep my local file\n');
  const second = await f.offer('snapshot');
  await f.finish(second.publication, await f.publisher.apply(second.publication, f.signal));
  assert.equal((await second.response).isError, false);
  assert.equal(await readFile(join(f.local, 'README.md'), 'utf8'), 'second publication\n');
  assert.equal(await readFile(join(f.local, 'unrelated'), 'utf8'), 'keep my local file\n');
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), index);
});

test('snapshot conflicts preserve every local file and retain the imported patch for review', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, 'README.md'), 'remote edit\n'); await writeFile(join(f.target, 'new'), 'remote addition\n');
  await writeFile(join(f.local, 'README.md'), 'my local edit\n');
  const { publication, response } = await f.offer('snapshot');
  await assert.rejects(f.publisher.apply(publication, f.signal), /Local edits overlap/);
  assert.equal(await readFile(join(f.local, 'README.md'), 'utf8'), 'my local edit\n');
  await assert.rejects(readFile(join(f.local, 'new')), /ENOENT/);
  const storage = await gitText(f.local, ['rev-parse', '--git-path', 'juiced-publications']);
  assert.ok(storage);
  assert.equal(await gitText(f.local, ['rev-parse', `refs/juiced/imports/${f.project.workspace}/${publication.id}/snapshot^{tree}`]), publication.manifest.snapshot!.tree);
  await f.finish(publication, { status: 'conflict', message: 'Local edits overlap.' });
  assert.equal((await response).isError, true);
});

test('dirty or changed-branch commit publications cannot update the checkout', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, 'result'), 'remote'); await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'remote']);
  const first = await f.offer('commits');
  await writeFile(join(f.local, 'local edit'), 'keep');
  await assert.rejects(f.publisher.apply(first.publication, f.signal), /must be clean/);
  await f.finish(first.publication, { status: 'conflict', message: 'Dirty checkout' }); await first.response;
  await git(f.local, ['checkout', '-b', 'other']);
  const second = await f.offer('commits');
  await assert.rejects(f.publisher.apply(second.publication, f.signal), /source branch changed/);
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), f.repository.head);
  await f.finish(second.publication, { status: 'declined', message: 'Declined' }); await second.response;
});

test('only one client can claim an offer, and denial does not advance the shared snapshot baseline', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, 'README.md'), 'remote');
  const first = await f.offer('snapshot'), owner = randomUUID();
  await f.bridge.input({ type: 'publish-claim', id: first.publication.id, client: owner });
  await assert.rejects(f.bridge.input({ type: 'publish-claim', id: first.publication.id, client: randomUUID() }), /Another local client/);
  await f.finish(first.publication, { status: 'declined', message: 'Declined' }, owner); await first.response;
  const second = await f.offer('snapshot');
  assert.equal(second.publication.manifest.snapshot!.baseTree, first.publication.manifest.snapshot!.baseTree);
  await f.finish(second.publication, { status: 'declined', message: 'Declined' }); await second.response;
  assert.equal(await readFile(join(f.local, 'README.md'), 'utf8'), 'base\n');
});

test('corrupt bundles and ignored file collisions fail before any snapshot write', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.target, '.env'), 'remote tracked data'); await git(f.target, ['add', '-f', '.env']);
  await writeFile(join(f.local, '.env'), 'local ignored data');
  const first = await f.offer('snapshot');
  const corrupt = structuredClone(first.publication); corrupt.manifest.file.sha256 = '0'.repeat(64);
  await assert.rejects(f.publisher.apply(corrupt, f.signal), /checksum|incomplete/);
  await assert.rejects(f.publisher.apply(first.publication, f.signal), /already exists/);
  assert.equal(await readFile(join(f.local, '.env'), 'utf8'), 'local ignored data');
  await f.finish(first.publication, { status: 'conflict', message: 'File collision' }); await first.response;
});


test('MCP pulls a pinned laptop snapshot into its live checkout and preserves staging and cwd', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const active = await acquireCheckout(await f.context('claude').database(), f.project.directoryName, 'claude', 'session', () => {});
  f.releases.push(() => active.release());
  const before = await lstat(f.target);
  await writeFile(join(f.local, 'committed'), 'local commit');
  await git(f.local, ['add', 'committed']); await git(f.local, ['commit', '-m', 'laptop commit']);
  const head = await gitText(f.local, ['rev-parse', 'HEAD']);
  await writeFile(join(f.local, 'README.md'), 'staged laptop edit\n'); await git(f.local, ['add', 'README.md']);
  await writeFile(join(f.local, 'README.md'), 'unstaged laptop edit\n');
  await rm(join(f.local, 'remove'));
  const binary = randomBytes(500);
  await writeFile(join(f.local, 'new.bin'), binary);
  await writeFile(join(f.local, '.env'), 'stay on laptop');
  await symlink('README.md', join(f.local, 'link'));
  await writeFile(join(f.local, 'run'), '#!/bin/sh\n'); await chmod(join(f.local, 'run'), 0o755);
  const index = await readFile(join(f.local, '.git', 'index'));
  const ui = f.attachUploader();
  const { request, response } = await f.pull();
  await until(() => ui.approvals.has(request.id));
  assert.equal(ui.approvals.get(request.id)?.upload, true);
  assert.equal(ui.approvals.get(request.id)?.input.commit, head);
  assert.ok((ui.approvals.get(request.id)?.input.paths as string[]).includes('new.bin'));
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
  // Approval applies the previewed bytes even when the laptop is edited afterwards.
  await writeFile(join(f.local, 'README.md'), 'later local edit\n');
  await ui.broker.answer(request.id, true);
  const result = await response;
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), head);
  assert.equal(await gitText(f.target, ['show', ':README.md']), 'staged laptop edit');
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'unstaged laptop edit\n');
  assert.deepEqual(await readFile(join(f.target, 'new.bin')), binary);
  assert.equal(await readlink(join(f.target, 'link')), 'README.md');
  assert.ok((await lstat(join(f.target, 'run'))).mode & 0o111);
  await assert.rejects(readFile(join(f.target, 'remove')), /ENOENT/);
  await assert.rejects(readFile(join(f.target, '.env')), /ENOENT/);
  assert.equal((await lstat(f.target)).ino, before.ino, 'Claude keeps the same directory inode');
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), index);
  assert.equal(await readFile(join(f.local, 'README.md'), 'utf8'), 'later local edit\n');
  assert.ok(ui.frames.some(frame => String(frame.message).includes('Applied local')));
  const binding = JSON.parse(await readFile(join(f.remote, '.juiced', f.project.directoryName, 'binding.json'), 'utf8'));
  assert.equal(binding.publishBase.head, head);
  await writeFile(join(f.local, 'README.md'), 'unstaged laptop edit\n');
  await writeFile(join(f.target, 'README.md'), 'unstaged laptop edit\nremote follow-up\n');
  const published = await f.offer('snapshot');
  const applied = await f.publisher.apply(published.publication, f.signal);
  await f.finish(published.publication, applied);
  assert.equal((await published.response).isError, false);
  assert.equal(await readFile(join(f.local, 'README.md'), 'utf8'), 'unstaged laptop edit\nremote follow-up\n');
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), index);
});

test('declining a laptop upload sends no bytes; commits-only excludes uncommitted changes', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const ui = f.attachUploader();
  await writeFile(join(f.local, 'README.md'), 'do not send\n');
  const denied = await f.pull(); await until(() => ui.approvals.has(denied.request.id));
  await ui.broker.answer(denied.request.id, false);
  assert.equal((await denied.response).isError, true);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
  await writeFile(join(f.local, 'committed'), 'include me'); await git(f.local, ['add', 'committed']); await git(f.local, ['commit', '-m', 'local work']);
  const allowed = await f.pull({ include_uncommitted: false }); await until(() => ui.approvals.has(allowed.request.id));
  await ui.broker.answer(allowed.request.id, true);
  assert.equal((await allowed.response).isError, false);
  assert.equal(await readFile(join(f.target, 'committed'), 'utf8'), 'include me');
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
});

test('laptop uploads refuse other sessions, remote edits, and changes made while approval is pending', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const ui = f.attachUploader();
  await writeFile(join(f.local, 'README.md'), 'laptop edit\n');
  const other = await acquireCheckout(await f.context('other').database(), f.project.directoryName, 'other', 'session', () => {});
  const busy = await f.pull(); await until(() => ui.approvals.has(busy.request.id)); await ui.broker.answer(busy.request.id, true);
  assert.equal((await busy.response).isError, true);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
  await other.release();
  const dirty = await f.pull(); await until(() => ui.approvals.has(dirty.request.id));
  await writeFile(join(f.target, 'README.md'), 'keep remote edit\n');
  await ui.broker.answer(dirty.request.id, true);
  assert.equal((await dirty.response).isError, true);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'keep remote edit\n');
  await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'remote work']);
  const divergent = await f.pull();
  assert.equal((await divergent.response).isError, true, 'An unknown remote HEAD cannot replace laptop history');
  assert.equal(ui.approvals.has(divergent.request.id), false, 'Failed capture never offers an empty approval');
});


test('uploads reject corrupt artifacts, ignored collisions, and remote HEAD changes before writing files', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'README.md'), 'laptop edit\n');
  const first = await f.pull();
  await f.uploader.prepare(first.request, f.signal);
  const result = await f.uploader.send(first.request, f.signal);
  const transfer = join(f.remote, '.juiced', f.project.directoryName, 'transfers', result.uploadId!);
  await writeFile(join(transfer, 'bundle'), 'corrupt');
  const owner = randomUUID();
  await f.bridge.input({ type: 'publish-claim', id: first.request.id, client: owner });
  const failure = await f.bridge.input({ type: 'publish-result', id: first.request.id, client: owner, result });
  assert.equal(failure?.status, 'conflict');
  assert.equal((await first.response).isError, true);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
  const repeated = await f.bridge.input({ type: 'publish-result', id: first.request.id, client: owner, result });
  assert.deepEqual(repeated, failure, 'Result retries retain the original outcome');
  // A tracked laptop file must never replace an ignored remote secret.
  await writeFile(join(f.local, '.env'), 'local tracked file'); await git(f.local, ['add', '-f', '.env']);
  await git(f.local, ['commit', '-m', 'track env']);
  await writeFile(join(f.target, '.env'), 'remote secret');
  const ui = f.attachUploader();
  const collision = await f.pull(); await until(() => ui.approvals.has(collision.request.id));
  await ui.broker.answer(collision.request.id, true);
  assert.equal((await collision.response).isError, true);
  assert.equal(await readFile(join(f.target, '.env'), 'utf8'), 'remote secret');
  await rm(join(f.target, '.env'));
  const changed = await f.pull(); await until(() => ui.approvals.has(changed.request.id));
  await writeFile(join(f.target, 'remote'), 'remote commit'); await git(f.target, ['add', 'remote']); await git(f.target, ['commit', '-m', 'advance remotely']);
  const head = await gitText(f.target, ['rev-parse', 'HEAD']);
  await ui.broker.answer(changed.request.id, true);
  assert.equal((await changed.response).isError, true);
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), head);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
});

test('uploads refuse removal of the running session working directory', { timeout: 30_000 }, async t => {
  const f = await fixture(t, false, 'nested');
  await mkdir(join(f.local, 'nested')); await writeFile(join(f.local, 'nested', 'entry'), 'keep cwd');
  await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'add launch directory']);
  const ui = f.attachUploader();
  const initial = await f.pull(); await until(() => ui.approvals.has(initial.request.id));
  await ui.broker.answer(initial.request.id, true); assert.equal((await initial.response).isError, false);
  const inode = (await lstat(join(f.target, 'nested'))).ino;
  await rm(join(f.local, 'nested'), { recursive: true }); await git(f.local, ['add', '-A']); await git(f.local, ['commit', '-m', 'remove launch directory']);
  const removed = await f.pull(); await until(() => ui.approvals.has(removed.request.id));
  await ui.broker.answer(removed.request.id, true);
  assert.equal((await removed.response).isError, true);
  assert.equal((await lstat(join(f.target, 'nested'))).ino, inode);
});


test('a cancelled MCP upload cannot apply bytes that were already transferred', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'README.md'), 'cancel this upload\n');
  const pending = await f.pull();
  await f.uploader.prepare(pending.request, f.signal);
  const uploaded = await f.uploader.send(pending.request, f.signal);
  const client = randomUUID();
  await f.bridge.input({ type: 'publish-claim', id: pending.request.id, client });
  pending.cancel();
  assert.equal((await pending.response).isError, true);
  // The MCP child reports its socket closure before the runtime necessarily
  // observes it. Wait for the runtime's completion event before retrying there.
  await poll(() => f.completed.includes(pending.request.id), { message: 'Runtime did not finish the cancelled upload' });
  await assert.rejects(f.bridge.input({ type: 'publish-claim', id: pending.request.id, client: randomUUID() }), /no longer pending/);
  await assert.rejects(f.bridge.input({ type: 'publish-result', id: pending.request.id, client, result: uploaded }), /no longer pending/);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
  await assert.rejects(readFile(join(f.remote, '.juiced', f.project.directoryName, 'transfers', uploaded.uploadId!, 'live-started.json')), /ENOENT/);
});
