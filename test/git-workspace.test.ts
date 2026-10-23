import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createClient } from '@libsql/client';
import { CantelopClient, RemoteAppError, type AppCommandEnvelope, type SessionEvent } from '@cantelop/sdk';
import type { WorkspaceDatabase } from '@cantelop/sdk/session';
import { createUpload, discoverRepository, fileInfo, git, gitText } from '../src/git.js';
import { createGitSession, GitWorkspaceClient } from '../src/git-workspace.js';
import { selectProject } from '../src/project.js';
import { createGitRuntime } from '../src/runtime/git.js';
import { acquireCheckout, CheckoutBusy } from '../src/runtime/project-state.js';
import { createTerminal } from '../src/runtime/terminal.js';
import { transferFailure } from '../src/agent/publications.js';
import { UPLOAD_CHUNK_BYTES, type GitCommand } from '../src/git-protocol.js';
import { until } from './fixtures/wait.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from '../src/protocol.js';

async function fixture(t: test.TestContext, beforeChunk?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-git-test-')));
  const local = join(root, 'local'); const remote = join(root, 'remote');
  await mkdir(local); await mkdir(remote);
  await git(local, ['init', '-b', 'main']);
  await git(local, ['config', 'user.name', 'Test Author']); await git(local, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(local, 'README.md'), 'base\n');
  await writeFile(join(local, 'remove.txt'), 'delete me\n');
  await writeFile(join(local, '.gitignore'), '.env\nnode_modules/\n');
  await git(local, ['add', '.']); await git(local, ['commit', '-m', 'base']);
  const project = await selectProject(local);
  const db = createClient({ url: `file:${join(root, 'leases.db')}` });
  const lifetime = new AbortController();
  const commands: GitCommand[] = []; const stopped: string[] = [];
  const runtimes = new Map<string, ReturnType<typeof createGitRuntime>>();
  const histories = new Map<string, SessionEvent<TerminalEvent>[]>();
  const emitted = new EventEmitter();
  let failChunk = false; let failStream = false; let dropped = false;
  let streamFailure: Error | undefined;
  const context = (id: string) => ({ signal: lifetime.signal, session: { id, keepAliveSeconds: 120 }, env: {}, database: async () => db as WorkspaceDatabase });
  const app = new CantelopClient().app<TerminalCommand, TerminalEvent, TerminalReply>({
    name: 'juiced-git-test', runtime: { receive() {} },
    connection: {
      async fetch(request) {
        const envelope = await request.json() as AppCommandEnvelope<TerminalCommand>;
        const id = envelope.session!.id;
        const operation = envelope.command;
        if (operation.type === 'request') {
          const command = operation.message;
          assert.equal(command.type, 'git'); if (command.type !== 'git') throw new Error('Expected Git command');
          commands.push(command);
          if (command.action === 'chunk') await beforeChunk?.();
          let runtime = runtimes.get(id);
          if (!runtime) { runtime = createGitRuntime(context(id), remote); runtimes.set(id, runtime); }
          let reply: TerminalReply;
          try {
            if (command.action === 'download') {
              const history = histories.get(id) ?? []; histories.set(id, history);
              void runtime.handle(command, { async send(data) {
                history.push({ cursor: { streamId: 'a'.repeat(32), sequence: history.length + 1 }, data, sessionId: id, messageId: envelope.id, createdAt: new Date() }); emitted.emit(id);
              } }).catch(error => { history.push({ cursor: { streamId: 'a'.repeat(32), sequence: history.length + 1 }, data: { type: 'git-error', id: command.id, message: error.message }, sessionId: id, messageId: envelope.id, createdAt: new Date() }); emitted.emit(id); });
              reply = { ok: true };
            } else reply = { ok: true, git: await runtime.handle(command) };
          } catch (error) { reply = { ok: false, error: (error as Error).message, ...(error instanceof CheckoutBusy ? { busy: error.kind, ...(error.stale.length ? { stale: error.stale } : {}) } : {}) }; }
          if (command.action === 'chunk' && failChunk) { failChunk = false; throw new Error('network connection lost after upload'); }
          return Response.json({ protocolVersion: 2, id: envelope.id, reply });
        }
        if (operation.type === 'stream') {
          if (streamFailure) throw streamFailure;
          let index = operation.after?.sequence ?? 0;
          const abort = new AbortController(); const signal = AbortSignal.any([request.signal, abort.signal]);
          return new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (failStream && index > 0 && !dropped) { dropped = true; controller.error(new Error('network stream lost')); return; }
              while (!histories.get(id)?.[index]) await once(emitted, id, { signal });
              const event = histories.get(id)![index++]!;
              const document = { stream_id: event.cursor.streamId, sequence: event.cursor.sequence, session_id: id, message_id: event.messageId, created_at: event.createdAt.toISOString(), data: event.data };
              controller.enqueue(new TextEncoder().encode(`id: ${event.cursor.streamId}:${event.cursor.sequence}\ndata: ${JSON.stringify(document)}\n\n`));
            },
            cancel() { abort.abort(); },
          }), { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (operation.type === 'stop') { stopped.push(id); return Response.json({ protocolVersion: 2, id: envelope.id }); }
        throw new Error(`Unexpected operation ${operation.type}`);
      },
    },
  });
  const workspace = app.workspace({ slug: project.workspace });
  const client = async () => new GitWorkspaceClient(workspace, project, (await discoverRepository(local))!, lifetime.signal);
  t.after(async () => { lifetime.abort(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, local, remote, target: join(remote, project.directoryName), project, db, context, client, lifetime, commands, stopped,
    failNextChunk() { failChunk = true; }, failNextStream() { failStream = true; },
    failStreams(error: Error) { streamFailure = error; } };
}

test('SDK round trip preserves exact unpublished commits and imports branches before optional fast-forward', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'unpublished'), 'local only'); await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'unpublished']);
  const base = await gitText(f.local, ['rev-parse', 'HEAD']);
  const client = await f.client();
  await client.send(false, true);
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), base);
  await git(f.target, ['checkout', '-b', 'agent/result']);
  await writeFile(join(f.target, 'agent.bin'), randomBytes(180_000));
  await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'remote result']);
  const remoteHead = await gitText(f.target, ['rev-parse', 'HEAD']);
  await client.send(false, true); // A second launch must preserve the workspace.
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), remoteHead);
  f.failNextStream();
  const imported = await client.receive();
  assert.equal(imported.head, remoteHead);
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), base);
  assert.equal(await gitText(f.local, ['rev-parse', `refs/remotes/juiced/${f.project.workspace}/agent/result`]), remoteHead);
  await assert.rejects(readFile(join(f.local, 'agent.bin')), /ENOENT/);
  await client.fastForward();
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), remoteHead);
  assert.deepEqual(await readFile(join(f.local, 'agent.bin')), await readFile(join(f.target, 'agent.bin')));
  await client.close();
});

test('uncommitted snapshots preserve staging, binaries, deletions, modes and local index bytes', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const client = await f.client(); await client.send(false);
  await writeFile(join(f.local, 'README.md'), 'staged\n'); await git(f.local, ['add', 'README.md']);
  await writeFile(join(f.local, 'README.md'), 'unstaged\n');
  await rm(join(f.local, 'remove.txt'));
  await writeFile(join(f.local, 'new file\n🍈.bin'), randomBytes(300));
  await writeFile(join(f.local, 'executable'), '#!/bin/sh\n'); await chmod(join(f.local, 'executable'), 0o755);
  await symlink('README.md', join(f.local, 'link'));
  await writeFile(join(f.local, '.env'), 'ignored');
  const originalIndex = await readFile(join(f.local, '.git', 'index'));
  const staged = await git(f.local, ['diff', '--cached', '--binary']);
  const unstaged = await git(f.local, ['diff', '--binary']);
  f.failNextChunk();
  await client.send(true);
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), originalIndex);
  assert.deepEqual(await git(f.local, ['diff', '--cached', '--binary']), staged);
  assert.deepEqual(await git(f.local, ['diff', '--binary']), unstaged);
  assert.deepEqual(await git(f.target, ['diff', '--cached', '--binary']), staged);
  assert.equal(await gitText(f.target, ['show', ':README.md']), 'staged');
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'unstaged\n');
  assert.deepEqual(await readFile(join(f.target, 'new file\n🍈.bin')), await readFile(join(f.local, 'new file\n🍈.bin')));
  assert.ok((await lstat(join(f.target, 'executable'))).mode & 0o111);
  assert.ok((await lstat(join(f.target, 'link'))).isSymbolicLink());
  await assert.rejects(readFile(join(f.target, '.env')), /ENOENT/);
  await assert.rejects(readFile(join(f.target, 'remove.txt')), /ENOENT/);
  await git(f.target, ['add', '-A']); await git(f.target, ['commit', '-m', 'snapshot and agent work']);
  await assert.rejects(client.fastForward(), /local checkout must be clean/);
  assert.deepEqual(await readFile(join(f.local, '.git', 'index')), originalIndex);
  await client.close();
});

test('outbound updates preserve ignored remote files and reject dirty or divergent checkouts', { timeout: 30_000 }, async t => {
  const f = await fixture(t); let client = await f.client(); await client.send(false); await client.close();
  await writeFile(join(f.target, '.env'), 'remote secret');
  await writeFile(join(f.local, 'new'), 'local update'); await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'update']);
  client = await f.client(); await client.send(false);
  assert.equal(await readFile(join(f.target, '.env'), 'utf8'), 'remote secret');
  await writeFile(join(f.target, 'README.md'), 'remote edit');
  await assert.rejects(client.send(false), /remote checkout has uncommitted/);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'remote edit');
  await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'remote branch']);
  await writeFile(join(f.local, 'README.md'), 'local edit'); await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'local branch']);
  await client.close(); client = await f.client();
  const previous = await gitText(f.target, ['rev-parse', 'HEAD']);
  await assert.rejects(client.send(false), /histories diverged/);
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), previous);
  await assert.rejects(client.fastForward(), /histories diverged/);
  await client.close();
});

test('legacy files and mismatched repositories are preserved', async t => {
  const f = await fixture(t); await mkdir(f.target); await writeFile(join(f.target, 'legacy'), 'keep');
  const client = await f.client();
  await assert.rejects(client.send(false), /older synced files/);
  assert.equal(await readFile(join(f.target, 'legacy'), 'utf8'), 'keep');
  await rm(f.target, { recursive: true }); await client.send(false);
  const runtime = createGitRuntime(f.context('other'), f.remote);
  await assert.rejects(runtime.handle({ type: 'git', action: 'status', directoryName: f.project.directoryName, binding: 'f'.repeat(64) }), /another local repository/);
  await client.close();
});

test('shared sessions block checkout updates and stale owners are stopped before recovery', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const client = await f.client(); await client.send(false);
  const first = await acquireCheckout(f.db, f.project.directoryName, 'session-1', 'session', () => {});
  const second = await acquireCheckout(f.db, f.project.directoryName, 'session-2', 'session', () => {});
  await assert.rejects(client.send(false), /checkout is in use/);
  await client.receive(); // Exporting pinned commits is allowed during sessions.
  await first.release(); await assert.rejects(client.send(false), /checkout is in use/);
  await second.release();
  const stale = await acquireCheckout(f.db, f.project.directoryName, 'dead-session', 'maintenance', () => {});
  await f.db.execute({ sql: 'UPDATE juiced_checkout_leases SET expires = 0 WHERE token = ?', args: [stale.token] });
  await client.send(false);
  assert.ok(f.stopped.includes('dead-session'));
  await stale.release(); await client.close();
});

test('nested directories and linked local worktrees use Git discovery and preserve the launch directory', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.local, 'packages')); await writeFile(join(f.local, 'packages', 'entry'), 'nested');
  await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'nested']);
  const linked = join(f.root, 'linked'); await git(f.local, ['worktree', 'add', '-b', 'linked', linked]);
  const repo = (await discoverRepository(join(linked, 'packages')))!;
  assert.equal(repo.relativeDirectory, 'packages'); assert.equal(repo.branch, 'linked');
  const upload = await createUpload(repo, true);
  assert.equal(upload.manifest.head, repo.head); await upload.close();
  const client = await f.client(); await client.send(false);
  const repository = (await discoverRepository(f.local))!;
  const terminal = createTerminal(f.context('nested-terminal'), { workspace: f.remote, binary: process.execPath });
  const events: TerminalEvent[] = [];
  await terminal.run({ type: 'start', argv: ['-e', 'console.log(process.cwd())'], columns: 80, rows: 24, tty: false, term: 'dumb', directoryName: f.project.directoryName, git: { binding: repository.binding, relativeDirectory: 'packages' } }, { signal: f.lifetime.signal, output: { async send(data) { events.push(data); } } });
  const text = events.filter(item => item.type === 'output').map(item => Buffer.from(item.data, 'base64').toString()).join('');
  assert.equal(text.trim(), join(f.target, 'packages'));
  assert.equal((await f.db.execute('SELECT * FROM juiced_checkout_leases')).rows.length, 0);
  await client.close();
});

test('interrupted publication is completed from its journal before checkout reuse', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const client = await f.client(); await client.send(false);
  const metadata = join(f.remote, '.juiced', f.project.directoryName);
  const id = randomUUID(); const transfer = join(metadata, 'transfers', id);
  await mkdir(transfer); await cp(f.target, join(transfer, 'candidate'), { recursive: true });
  await writeFile(join(transfer, 'candidate', 'recover'), 'published');
  const binding = JSON.parse(await readFile(join(metadata, 'binding.json'), 'utf8'));
  await writeFile(join(metadata, 'journal.json'), JSON.stringify({ id, binding, hadOriginal: true }));
  await rename(f.target, join(transfer, 'previous'));
  assert.equal((await client.status()).initialized, true);
  assert.equal(await readFile(join(f.target, 'recover'), 'utf8'), 'published');
  await client.close();
});

test('simultaneous first launches converge on one checkout', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const first = await f.client(); const second = await f.client();
  await Promise.all([first.send(false, true), second.send(false, true)]);
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), await gitText(f.local, ['rev-parse', 'HEAD']));
  await first.close(); await second.close();
});

test('unchanged commits send no bundle and patch-only uploads preserve staged and unstaged edits', async t => {
  const f = await fixture(t), client = await f.client();
  await client.send(false);
  const before = await lstat(join(f.target, 'README.md'));
  f.commands.length = 0;
  await client.send(false);
  const begin = f.commands.find(command => command.action === 'begin');
  assert.ok(begin?.action === 'begin');
  assert.equal(begin.manifest.base, begin.manifest.head);
  assert.deepEqual(begin.manifest.files, []);
  assert.ok(!f.commands.some(command => command.action === 'chunk'));
  assert.equal((await lstat(join(f.target, 'README.md'))).ino, before.ino, 'A no-op sync keeps the checkout in place');
  await writeFile(join(f.local, 'README.md'), 'staged\n');
  await git(f.local, ['add', 'README.md']);
  await writeFile(join(f.local, 'README.md'), 'unstaged\n');
  f.commands.length = 0;
  await client.send(true);
  const patch = f.commands.find(command => command.action === 'begin');
  assert.ok(patch?.action === 'begin');
  assert.ok(patch.manifest.files.every(file => file.name !== 'bundle'));
  assert.equal(await gitText(f.target, ['show', ':README.md']), 'staged');
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'unstaged\n');
  await client.close();
});

test('Git uploads pipeline a bounded window and accept reversed part arrival with a retried receipt', { timeout: 30_000 }, async t => {
  let holding = true;
  const waiting: Array<() => void> = [];
  const f = await fixture(t, async () => { if (holding) await new Promise<void>(resolve => waiting.push(resolve)); });
  await writeFile(join(f.local, 'large.bin'), randomBytes(2 * 1024 * 1024));
  await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'large upload']);
  const client = await f.client();
  f.failNextChunk();
  const sending = client.send(false);
  try {
    await until(() => waiting.length === 8);
    assert.equal(f.commands.filter(command => command.action === 'chunk').length, 8);
    assert.ok(!f.commands.some(command => command.action === 'finish'));
  } finally {
    holding = false;
    waiting.reverse().forEach(resolve => resolve());
    await sending;
  }
  assert.deepEqual(await readFile(join(f.target, 'large.bin')), await readFile(join(f.local, 'large.bin')));
  assert.equal(f.commands.filter(command => command.action === 'finish').length, 1);
  await client.close();
});

test('immutable upload parts survive replacement and reject missing or conflicting bytes before application', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'large.bin'), randomBytes(UPLOAD_CHUNK_BYTES * 2));
  await git(f.local, ['add', '.']); await git(f.local, ['commit', '-m', 'parts']);
  const repository = (await discoverRepository(f.local))!, upload = await createUpload(repository, false);
  t.after(() => upload.close());
  let runtime = createGitRuntime(f.context('parts'), f.remote);
  const base = { type: 'git' as const, directoryName: f.project.directoryName, binding: repository.binding, id: upload.id };
  await runtime.handle({ ...base, action: 'begin', manifest: upload.manifest });
  const bytes = await readFile(join(upload.directory, 'bundle'));
  const parts = Array.from({ length: Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES) }, (_, i) => ({ ...base, action: 'chunk' as const, part: true, file: 'bundle' as const, offset: i * UPLOAD_CHUNK_BYTES, data: bytes.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES).toString('base64') }));
  await Promise.all(parts.slice(1).reverse().map(part => runtime.handle(part)));
  await assert.rejects(runtime.handle({ ...base, action: 'finish' }), /Incomplete or corrupt/);
  await assert.rejects(lstat(f.target), /ENOENT/);
  runtime = createGitRuntime(f.context('parts'), f.remote);
  await Promise.all([runtime.handle(parts[0]!), runtime.handle(parts[0]!)]);
  await assert.rejects(runtime.handle({ ...parts[0]!, data: Buffer.alloc(UPLOAD_CHUNK_BYTES).toString('base64') }), /Conflicting transfer retry/);
  await runtime.handle({ ...base, action: 'finish' });
  await runtime.handle({ ...base, action: 'finish' });
  await runtime.handle({ ...base, action: 'apply', initializeOnly: false });
  assert.deepEqual(await readFile(join(f.target, 'large.bin')), await readFile(join(f.local, 'large.bin')));
});

test('a service device quota rejection waits for the next window with the same delivery identity', { timeout: 5000 }, async t => {
  const f = await fixture(t), repository = (await discoverRepository(f.local))!;
  let resume!: () => void;
  const waits: number[] = [];
  const timer = t.mock.method(timers, 'setTimeout', ((ms: number) => {
    waits.push(ms);
    return new Promise<void>(resolve => { resume = resolve; });
  }) as typeof timers.setTimeout);
  syncBuiltinESMExports();
  t.after(() => { timer.mock.restore(); syncBuiltinESMExports(); });
  const ids: string[] = [];
  const client = new GitWorkspaceClient({ session: () => ({
    id: 'quota-test',
    async request(_command: TerminalCommand, options: { id: string }) {
      ids.push(options.id);
      if (ids.length === 1) throw new RemoteAppError('command_outcome_unknown', 0, undefined, {
        cause: Object.assign(new Error('device quota'), { code: 'rate_limit_exceeded', status: 429 }),
      });
      return { ok: true as const, git: { status: { initialized: false } } };
    },
  }) } as unknown as ConstructorParameters<typeof GitWorkspaceClient>[0], f.project, repository, f.lifetime.signal);
  const pending = client.status();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(waits, [60_000]);
  assert.equal(ids.length, 1);
  resume();
  assert.deepEqual(await pending, { initialized: false });
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test('corrupt and conflicting upload chunks fail before checkout publication', async t => {
  const f = await fixture(t); const repository = (await discoverRepository(f.local))!;
  const upload = await createUpload(repository, false);
  const runtime = createGitRuntime(f.context('upload'), f.remote);
  const base = { type: 'git' as const, directoryName: f.project.directoryName, binding: repository.binding, id: upload.id };
  try {
    await runtime.handle({ ...base, action: 'begin', manifest: upload.manifest });
    const bytes = await readFile(join(upload.directory, 'bundle'));
    const partial = bytes.subarray(0, 50);
    const chunk = { ...base, action: 'chunk' as const, file: 'bundle' as const, offset: 0, data: partial.toString('base64') };
    assert.equal((await runtime.handle(chunk)).offset, 50);
    assert.equal((await runtime.handle(chunk)).offset, 50);
    await assert.rejects(runtime.handle({ ...chunk, data: Buffer.alloc(50).toString('base64') }), /Conflicting transfer retry/);
    await assert.rejects(runtime.handle({ ...chunk, offset: 60 }), /out of order/);
    await assert.rejects(runtime.handle({ ...base, action: 'apply', initializeOnly: false }), /Incomplete or corrupt/);
    await assert.rejects(lstat(f.target), /ENOENT/);
  } finally { await upload.close(); }
});

test('a snapshot that cannot apply leaves the original checkout intact', async t => {
  const f = await fixture(t); const client = await f.client(); await client.send(false);
  const repository = (await discoverRepository(f.local))!;
  const upload = await createUpload(repository, false);
  const invalid = Buffer.from('diff --git a/absent b/absent\n--- a/absent\n+++ b/absent\n@@ -1 +1 @@\n-missing\n+changed\n');
  await writeFile(join(upload.directory, 'unstaged'), invalid);
  upload.manifest.files.push(await fileInfo(join(upload.directory, 'unstaged'), 'unstaged'));
  const runtime = createGitRuntime(f.context('bad-snapshot'), f.remote);
  const base = { type: 'git' as const, directoryName: f.project.directoryName, binding: repository.binding, id: upload.id };
  try {
    await runtime.handle({ ...base, action: 'begin', manifest: upload.manifest });
    for (const file of upload.manifest.files) await runtime.handle({ ...base, action: 'chunk', file: file.name, offset: 0, data: (await readFile(join(upload.directory, file.name))).toString('base64') });
    await assert.rejects(runtime.handle({ ...base, action: 'apply', initializeOnly: false }), /absent/);
    assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), repository.head);
    assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'base\n');
  } finally { await upload.close(); await client.close(); }
});

test('detached HEAD workspaces import commits and require a source branch for fast-forward', async t => {
  const f = await fixture(t); await git(f.local, ['checkout', '--detach']);
  const client = await f.client(); await client.send(false);
  await writeFile(join(f.target, 'detached'), 'agent'); await git(f.target, ['add', '.']); await git(f.target, ['commit', '-m', 'detached result']);
  const imported = await client.receive();
  assert.equal(imported.head, await gitText(f.target, ['rev-parse', 'HEAD']));
  await assert.rejects(client.fastForward(), /source branch/);
  await client.close();
});

test('remote metadata initializes and refreshes existing workspaces without changing files, index or HEAD', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await git(f.local, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
  await git(f.local, ['config', 'branch.main.remote', 'origin']);
  await git(f.local, ['config', 'branch.main.merge', 'refs/heads/main']);
  let client = await f.client();
  await client.send(false, true);
  assert.equal(await gitText(f.target, ['remote', 'get-url', 'origin']), 'https://github.com/owner/repo.git');
  assert.equal(await gitText(f.target, ['config', 'branch.main.merge']), 'refs/heads/main');
  await writeFile(join(f.target, 'README.md'), 'agent uncommitted work\n');
  await git(f.target, ['add', 'README.md']);
  const head = await gitText(f.target, ['rev-parse', 'HEAD']);
  const index = await readFile(join(f.target, '.git', 'index'));
  await git(f.target, ['remote', 'add', 'agent-added', 'https://example.test/agent.git']);
  await git(f.local, ['remote', 'set-url', 'origin', 'https://github.com/owner/new.git']);
  await git(f.local, ['remote', 'set-url', '--push', 'origin', 'ssh://git@github.com/owner/push.git']);
  client = await f.client();
  await client.send(false, true);
  assert.equal(await gitText(f.target, ['remote', 'get-url', 'origin']), 'https://github.com/owner/new.git');
  assert.equal(await gitText(f.target, ['remote', 'get-url', '--push', 'origin']), 'https://github.com/owner/push.git');
  assert.equal(await gitText(f.target, ['remote', 'get-url', 'agent-added']), 'https://example.test/agent.git');
  assert.equal(await gitText(f.target, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(await readFile(join(f.target, '.git', 'index')), index);
  assert.equal(await readFile(join(f.target, 'README.md'), 'utf8'), 'agent uncommitted work\n');
  await git(f.local, ['remote', 'remove', 'origin']);
  client = await f.client(); await client.send(false, true);
  assert.equal(await gitText(f.target, ['remote']), 'agent-added');
});

test('credentialed remote URLs fail before transfer without disclosing the token', async t => {
  const f = await fixture(t);
  await git(f.local, ['remote', 'add', 'origin', 'https://user:fixture-private-token@github.com/owner/repo.git']);
  const client = await f.client();
  await assert.rejects(client.send(false, true), error => error instanceof Error && !error.message.includes('fixture-private-token') && /credentials/.test(error.message));
  assert.equal(f.commands.some(command => command.action === 'begin'), false);
});

test('Git stop delegates once to the service and blocks subsequent mutations', async () => {
  let stops = 0;
  const session = createGitSession({ session() { return { id: 'ses_' + 'a'.repeat(32) } as ReturnType<Parameters<typeof createGitSession>[0]['session']>; } }, async id => {
    assert.equal(id, 'ses_' + 'a'.repeat(32)); stops++;
  });
  await Promise.all([session.stop(), session.stop()]);
  assert.equal(stops, 1);
  assert.throws(() => session.request({ type: 'heartbeat' }), /has stopped/);
});

test('an unborn HEAD is reported as a repository without commits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-unborn-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await assert.rejects(discoverRepository(root), /has no commits/);
});

test('Git transfers wait out session admission timeouts with the same message identity', async () => {
  const ids: string[] = [];
  let waited = 0;
  const workspace = { session: () => ({ async request(_command: unknown, options: { id: string }) {
    ids.push(options.id);
    if (ids.length < 4) throw new RemoteAppError('session_admission_timeout', 409);
    return { ok: true, git: { status: { initialized: true } } };
  } }) } as never;
  const client = new GitWorkspaceClient(workspace, { directoryName: 'project' } as never, { binding: 'binding' } as never, new AbortController().signal, () => waited++);
  assert.deepEqual(await client.status(), { initialized: true });
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 1);
  assert.equal(waited, 1);
});

test('raw download subscription failures are typed at the transport boundary', async t => {
  const f = await fixture(t);
  const head = await gitText(f.local, ['rev-parse', 'HEAD']);
  const client = await f.client();
  await client.send(false);
  const error = new TypeError('fetch failed');
  f.failStreams(error);
  await assert.rejects(client.receive(), failure => {
    assert.ok(failure instanceof RemoteAppError);
    assert.equal(failure.cause, error);
    assert.equal(transferFailure({ kind: 'commits' } as never, failure, 'fallback').status, 'failed');
    return true;
  });
  assert.equal(await gitText(f.local, ['rev-parse', 'HEAD']), head);
});
