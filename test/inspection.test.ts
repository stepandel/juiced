import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import stringWidth from 'string-width';
import { CantelopClient, type AppCommandEnvelope, type SessionEvent } from '@cantelop/sdk';
import { parseArguments } from '../src/args.js';
import { discoverRepository, git, gitText, sha256 } from '../src/git.js';
import { captureInspection } from '../src/inspection-snapshot.js';
import { compareInspection, renderInspection } from '../src/inspection-view.js';
import { InspectionIncomplete, validateInspectionSnapshot, type InspectionCommand, type InspectionEvent } from '../src/inspection-protocol.js';
import { inspectWorkspace, remoteSnapshot } from '../src/inspect-workspace.js';
import { inspectRemote } from '../src/runtime/inspection.js';
import { selectProject } from '../src/project.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from '../src/protocol.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-inspection-test-')));
  const local = join(root, 'project'), workspace = join(root, 'workspace'), remote = join(workspace, 'project');
  await mkdir(local); await mkdir(workspace);
  await git(local, ['init', '-b', 'main']);
  await git(local, ['config', 'user.name', 'Inspection Test']); await git(local, ['config', 'user.email', 'test@example.test']);
  await mkdir(join(local, 'src')); await mkdir(join(local, 'docs'));
  await writeFile(join(local, 'src', 'entry.ts'), 'base\n');
  await writeFile(join(local, 'docs', 'guide.md'), 'guide\n');
  await writeFile(join(local, '.gitignore'), '.env\nnode_modules/\n');
  await writeFile(join(local, 'README.md'), 'same\n');
  await git(local, ['add', '.']); await git(local, ['commit', '-m', 'base']);
  await git(root, ['clone', '--no-hardlinks', local, remote]);
  const repository = (await discoverRepository(local))!;
  await mkdir(join(workspace, '.juiced', 'project'), { recursive: true });
  await writeFile(join(workspace, '.juiced', 'project', 'binding.json'), JSON.stringify({ version: 1, binding: repository.binding, sourceBranch: 'main' }));
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true }); });
  const snapshot = (path: string, scope = '', ignored = false) => captureInspection(path, scope, ignored, controller.signal);
  return { root, local, workspace, remote, repository, controller, snapshot };
}

// Independent byte/metadata oracle, including every .git object, index and ref.
async function state(root: string, prefix = ''): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), relative = prefix + name, info = await lstat(path);
    if (info.isDirectory()) result.push([relative + '/', info.mode], ...await state(path, relative + '/'));
    else result.push([relative, info.mode, info.isSymbolicLink() ? await readlink(path) : await readFile(path)]);
  }
  return result;
}

test('inspection commands validate paths/options and preserve literal Claude prompts', () => {
  for (const action of ['ls', 'peek'] as const) {
    assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', action], {}), { command: 'claude', action, workspace: 'chosen', path: '.', includeIgnored: false, argv: [] });
    assert.equal(parseArguments(['claude', action, '--help'], {}).command, 'help');
    const selected = parseArguments(['claude', action, '--include-ignored', 'src/'], {});
    assert.equal(selected.command === 'claude' && selected.action === action && 'path' in selected && selected.path, 'src/');
    assert.equal(parseArguments(['claude', action, '--', '-file'], {}).command, 'claude');
    for (const extra of [['--include-ignored'], ['--wat'], ['a', 'b'], ['../other'], ['/etc'], ['.git/config'], ['a/../../b'], ['a\\b']]) assert.throws(() => parseArguments(['claude', action, ...extra], {}));
    assert.deepEqual(parseArguments(['claude', '--', action], {}), { command: 'claude', action: 'run', workspace: undefined, argv: [action] });
  }
});

test('Git snapshots include dirty/untracked work and summarize descendants without changing repositories', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'src', 'entry.ts'), 'staged\n'); await git(f.local, ['add', 'src/entry.ts']);
  await writeFile(join(f.local, 'src', 'entry.ts'), 'unstaged\n');
  await writeFile(join(f.local, 'README.md'), 'staged only\n'); await git(f.local, ['add', 'README.md']);
  await writeFile(join(f.local, 'README.md'), 'same\n');
  await writeFile(join(f.remote, 'src', 'new.bin'), Buffer.from([0, 1, 255]));
  await rm(join(f.remote, 'docs', 'guide.md'));
  await symlink('README.md', join(f.local, 'link'));
  await writeFile(join(f.remote, 'link'), 'a file\n');
  await writeFile(join(f.local, '.env'), 'ignored\n');
  const before = await Promise.all([state(f.local), state(f.remote), state(join(f.workspace, '.juiced'))]);
  const local = await f.snapshot(f.local), remote = await f.snapshot(f.remote);
  validateInspectionSnapshot(local, '');
  const rows = compareInspection(local, remote).rows;
  assert.equal(rows.find(row => row.name === 'src')?.status, 'different');
  assert.equal(rows.find(row => row.name === 'src')?.local?.mode, '040000');
  assert.equal(rows.find(row => row.name === 'docs')?.status, 'local only');
  assert.equal(rows.find(row => row.name === 'link')?.status, 'different');
  assert.equal(rows.find(row => row.name === 'README.md')?.status, 'matching');
  assert.ok(!rows.some(row => row.name === '.env' || row.name.includes('/')));
  assert.deepEqual(await Promise.all([state(f.local), state(f.remote), state(join(f.workspace, '.juiced'))]), before);
  const nested = compareInspection(await f.snapshot(f.local, 'src'), await f.snapshot(f.remote, 'src'));
  assert.equal(nested.rows.find(row => row.name === 'new.bin')?.status, 'remote only');
  assert.equal(nested.rows.find(row => row.name === 'entry.ts')?.status, 'different');
  assert.equal(await readFile(join(f.local, 'src', 'entry.ts'), 'utf8'), 'unstaged\n');
});

test('Git rather than raw-byte rules determine equality, modes, staged additions, and symlinks', async t => {
  const f = await fixture(t);
  for (const root of [f.local, f.remote]) {
    await writeFile(join(root, '.gitattributes'), '*.txt text eol=lf\n');
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\n');
    await symlink('missing-target', join(root, 'broken'));
  }
  await writeFile(join(f.local, 'normalized.txt'), 'line\r\n'); await writeFile(join(f.remote, 'normalized.txt'), 'line\n');
  await chmod(join(f.local, 'run.sh'), 0o755);
  await writeFile(join(f.local, '.env'), 'tracked addition\n'); await git(f.local, ['add', '-f', '.env']);
  const rows = compareInspection(await f.snapshot(f.local), await f.snapshot(f.remote)).rows;
  assert.equal(rows.find(row => row.name === 'normalized.txt')?.status, 'matching');
  assert.equal(rows.find(row => row.name === 'run.sh')?.status, 'different');
  assert.equal(rows.find(row => row.name === 'broken')?.status, 'matching');
  assert.equal(rows.find(row => row.name === '.env')?.status, 'local only');
});

test('ignored counterparts are excluded rather than missing and explicit inclusion is scoped', async t => {
  const f = await fixture(t);
  await writeFile(join(f.local, 'visible.txt'), 'same\n'); await writeFile(join(f.remote, 'visible.txt'), 'same\n');
  await writeFile(join(f.remote, '.git', 'info', 'exclude'), 'visible.txt\n');
  for (const root of [f.local, f.remote]) { await mkdir(join(root, 'generated')); await writeFile(join(root, 'generated', 'file'), 'same\n'); }
  await writeFile(join(f.remote, '.git', 'info', 'exclude'), 'visible.txt\ngenerated/\n');
  await writeFile(join(f.local, '.env'), 'left\n'); await writeFile(join(f.remote, '.env'), 'right\n');
  await mkdir(join(f.local, 'node_modules')); await writeFile(join(f.local, 'node_modules', 'ignored'), 'ignored\n');
  const rows = compareInspection(await f.snapshot(f.local), await f.snapshot(f.remote)).rows;
  assert.equal(rows.find(row => row.name === 'visible.txt')?.status, 'excluded');
  assert.equal(rows.find(row => row.name === 'visible.txt')?.remoteIgnored, true);
  assert.equal(rows.find(row => row.name === 'generated')?.status, 'excluded');
  assert.ok(!rows.some(row => row.name === '.env' || row.name === 'node_modules'));
  assert.equal((await f.snapshot(f.local, '.env')).kind, 'ignored');
  const included = compareInspection(await f.snapshot(f.local, '.env', true), await f.snapshot(f.remote, '.env', true));
  assert.equal(included.rows[0]?.status, 'different');
  assert.equal(included.rows.length, 1);
  await mkdir(join(f.remote, 'node_modules')); await writeFile(join(f.remote, 'node_modules', 'ignored'), 'different\n');
  assert.equal(compareInspection(await f.snapshot(f.local, 'node_modules', true), await f.snapshot(f.remote, 'node_modules', true)).rows[0]?.status, 'different');
});

test('linked worktrees use their own index and native object format without writes', async t => {
  const f = await fixture(t);
  const linked = join(f.root, 'linked:workspace');
  await git(f.local, ['worktree', 'add', '-b', 'linked', linked]);
  await writeFile(join(linked, 'src', 'entry.ts'), 'linked edit\n');
  const indexPath = await gitText(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const before = await readFile(indexPath);
  assert.equal(compareInspection(await f.snapshot(linked), await f.snapshot(f.remote)).rows.find(row => row.name === 'src')?.status, 'different');
  assert.deepEqual(await readFile(indexPath), before);
  await git(f.local, ['update-index', '--add', '--cacheinfo', `160000,${f.repository.head},submodule`]);
  await assert.rejects(f.snapshot(f.local), /Submodule contents/);
  assert.equal((await f.snapshot(f.local, 'README.md')).kind, 'file');
  const embedded = join(f.remote, 'src', 'embedded'); await mkdir(embedded);
  await git(embedded, ['init', '-b', 'main']); await git(embedded, ['config', 'user.name', 'Test']); await git(embedded, ['config', 'user.email', 'test@example.test']);
  await writeFile(join(embedded, 'file'), 'nested repo'); await git(embedded, ['add', '.']); await git(embedded, ['commit', '-m', 'nested']);
  await assert.rejects(f.snapshot(f.remote), /Submodule contents/);
});

test('file/directory conflicts, missing scopes, literal names and symlink ancestors are explicit', async t => {
  const f = await fixture(t);
  await rm(join(f.remote, 'src'), { recursive: true }); await writeFile(join(f.remote, 'src'), 'a file\n');
  assert.equal(compareInspection(await f.snapshot(f.local, 'src'), await f.snapshot(f.remote, 'src')).rows[0]?.status, 'different');
  assert.equal((await f.snapshot(f.local, 'missing')).kind, 'missing');
  for (const name of ['[literal]', '-dash', 'new\nline', '日本語']) {
    await writeFile(join(f.local, name), name);
    assert.equal((await f.snapshot(f.local, name)).entry?.name, name);
  }
  await symlink('../workspace', join(f.local, 'outside'));
  await assert.rejects(f.snapshot(f.local, 'outside/project'), /symlink ancestor/);
  assert.equal((await f.snapshot(f.local, 'outside')).entry?.mode, '120000');
});

test('large descendant sets remain one directory row and rendering wraps safely', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 250 }, (_, index) => writeFile(join(f.remote, 'src', `generated-${index}.ts`), String(index))));
  await writeFile(join(f.local, '日本語-long-name\n\u001b[31m.ts'), 'literal');
  const comparison = compareInspection(await f.snapshot(f.local), await f.snapshot(f.remote));
  assert.equal(comparison.rows.filter(row => row.name === 'src').length, 1);
  assert.equal(comparison.rows.length, 5);
  const base = { localRoot: f.local, remoteRoot: f.remote, workspace: 'chosen', workspaceId: `wsp_${'a'.repeat(32)}`, includeIgnored: false };
  for (const columns of [80, 40, 20]) {
    const view = renderInspection(comparison, { ...base, action: 'peek', columns });
    assert.ok(view.split('\n').every(line => stringWidth(line) <= columns), `${columns}-column overflow`);
    assert.ok(!view.includes('\u001b'));
    assert.ok(!view.includes('generated-'));
  }
  const ls = renderInspection(comparison, { ...base, action: 'ls', columns: undefined });
  const peek = renderInspection(comparison, { ...base, action: 'peek', columns: undefined });
  assert.match(ls, /README\.md\s+=\s+README\.md/);
  assert.doesNotMatch(peek, /README\.md\s+=/);
  assert.equal(ls.trim().split('\n').at(-2), peek.trim().split('\n').at(-2));
  assert.match(ls, /\\u000a\\u001b/);
});

test('remote inspection preserves missing state and publication journals without recovery', async t => {
  const f = await fixture(t);
  const command: InspectionCommand = { type: 'inspect', id: randomUUID(), directoryName: 'project', binding: f.repository.binding, scope: '', includeIgnored: false };
  const events: InspectionEvent[] = [];
  const output = { async send(event: InspectionEvent) { events.push(event); } };
  const empty = join(f.root, 'empty'); await mkdir(empty);
  await inspectRemote(command, output, f.controller.signal, empty);
  assert.equal(events[0]?.type, 'inspection-error'); assert.deepEqual(await readdir(empty), []);
  const journal = join(f.workspace, '.juiced', 'project', 'journal.json'); await writeFile(journal, '{"pending":true}');
  const before = await state(f.workspace); events.length = 0;
  await inspectRemote(command, output, f.controller.signal, f.workspace);
  assert.equal(events[0]?.type, 'inspection-error');
  assert.match(events[0]?.type === 'inspection-error' ? events[0].message : '', /pending recovery/);
  assert.deepEqual(await state(f.workspace), before);
});

test('real SDK request/stream uses the inspected canonical ID and never requires Claude or Cantelop CLI', { timeout: 30_000 }, async t => {
  const f = await fixture(t); await writeFile(join(f.remote, 'src', 'entry.ts'), 'remote dirty\n');
  const project = await selectProject(f.local);
  const workspaceId = `wsp_${'a'.repeat(32)}`;
  const calls: AppCommandEnvelope<TerminalCommand>[] = [];
  const histories = new Map<string, SessionEvent<TerminalEvent>[]>(), emitted = new EventEmitter();
  let exists = false;
  const app = new CantelopClient().app<TerminalCommand, TerminalEvent, TerminalReply>({ name: 'inspection-test', runtime: { receive() {} }, connection: {
    async fetch(request) {
      const body = await request.json() as AppCommandEnvelope<TerminalCommand>; calls.push(body);
      const operation = body.command;
      if (operation.type === 'workspace.inspect') return Response.json({ protocolVersion: 2, workspace: exists ? {
        id: workspaceId, slug: project.workspace, app_id: `app_${'b'.repeat(32)}`, hostname: 'fixture.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z',
      } : null });
      assert.deepEqual(body.workspace, { id: workspaceId });
      const id = body.session!.id;
      if (operation.type === 'request') {
        assert.equal(operation.message.type, 'inspect');
        const command = operation.message as InspectionCommand;
        const history: SessionEvent<TerminalEvent>[] = []; histories.set(id, history);
        void inspectRemote(command, { async send(data) {
          history.push({ data, sessionId: id, messageId: body.id, cursor: { streamId: 'a'.repeat(32), sequence: history.length + 1 }, createdAt: new Date() }); emitted.emit(id);
        } }, f.controller.signal, f.workspace).catch(error => emitted.emit('error', error));
        return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true } });
      }
      if (operation.type === 'stream') {
        let index = 0;
        return new Response(new ReadableStream({ async pull(controller) {
          while (!histories.get(id)?.[index]) await once(emitted, id, { signal: request.signal });
          const event = histories.get(id)![index++]!;
          controller.enqueue(new TextEncoder().encode(`id: ${event.cursor.streamId}:${event.cursor.sequence}\ndata: ${JSON.stringify({ stream_id: event.cursor.streamId, sequence: event.cursor.sequence, data: event.data, session_id: id, message_id: body.id, created_at: event.createdAt.toISOString() })}\n\n`));
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      assert.equal(operation.type, 'stop');
      return Response.json({ protocolVersion: 2, id: body.id });
    },
  } });
  const stdout = new PassThrough(); let text = ''; stdout.on('data', bytes => text += String(bytes));
  const options = { action: 'peek' as const, path: '.', includeIgnored: false };
  assert.equal(await inspectWorkspace(app, f.local, options, f.controller.signal, stdout), 2);
  assert.deepEqual(calls.map(call => call.command.type), ['workspace.inspect']);
  calls.length = 0; exists = true; text = '';
  const before = await state(f.workspace);
  assert.equal(await inspectWorkspace(app, f.local, options, f.controller.signal, stdout), 0);
  assert.match(text, /src\/\s+!\s+src\//);
  assert.ok(calls.every(call => ['workspace.inspect', 'request', 'stream', 'stop'].includes(call.command.type)));
  assert.equal(calls.filter(call => call.command.type === 'stop').length, 1);
  assert.deepEqual(await state(f.workspace), before);
});

test('invalid, truncated and reordered streams cannot produce a successful comparison', async t => {
  const f = await fixture(t); const snapshot = await f.snapshot(f.local); const bytes = Buffer.from(JSON.stringify(snapshot));
  const command: InspectionCommand = { type: 'inspect', id: randomUUID(), directoryName: 'project', binding: f.repository.binding, scope: '', includeIgnored: false };
  const chunk: InspectionEvent = { type: 'inspection-chunk', id: command.id, offset: 0, data: bytes.toString('base64') };
  const end: InspectionEvent = { type: 'inspection-end', id: command.id, size: bytes.length, sha256: sha256(bytes) };
  for (const events of [[chunk], [{ ...chunk, offset: 1 }, end], [chunk, { ...end, sha256: '0'.repeat(64) }], [{ ...chunk, data: '!!' }, end]]) {
    let stopped = false;
    const session = {
      request: async () => ({ ok: true as const }), stop: async () => { stopped = true; },
      async *stream() { for (const data of events) yield { data }; },
    };
    await assert.rejects(remoteSnapshot({ session: () => session } as unknown as Parameters<typeof remoteSnapshot>[0], command, f.controller.signal), InspectionIncomplete);
    assert.equal(stopped, true);
  }
  assert.throws(() => validateInspectionSnapshot({ ...snapshot, entries: [{ name: 'bad/path', mode: '100644', oid: 'a'.repeat(40) }] }, ''), /invalid/);
});

test('unreadable files and interrupted captures are reported without modifying Git state', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(captureInspection(f.local, '', false, controller.signal), /cancelled/);
  if (process.getuid?.() === 0) return;
  const before = await state(join(f.local, '.git'));
  await chmod(join(f.local, 'README.md'), 0o000);
  await assert.rejects(f.snapshot(f.local), /Unable to inspect checkout/);
  await chmod(join(f.local, 'README.md'), 0o644);
  assert.deepEqual(await state(join(f.local, '.git')), before);
});
