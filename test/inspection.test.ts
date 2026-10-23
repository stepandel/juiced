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
import { captureListing } from '../src/inspection-listing.js';
import { compareInspection, renderInspection, renderRemoteListing } from '../src/inspection-view.js';
import { InspectionIncomplete, validateInspectionListing, validateInspectionSnapshot, type InspectionCommand, type InspectionEvent } from '../src/inspection-protocol.js';
import { inspectWorkspace, remoteSnapshot } from '../src/inspect-workspace.js';
import { captureRemoteInspection, inspectRemote } from '../src/runtime/inspection.js';
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
    assert.deepEqual(parseArguments(['--workspace', 'chosen', 'claude', action], {}), { command: 'claude', action, workspace: 'chosen', path: '.', includeIgnored: false, ...(action === 'peek' ? { changesOnly: false } : {}), argv: [] });
    assert.equal(parseArguments(['claude', action, '--help'], {}).command, 'help');
    const selected = parseArguments(['claude', action, '--include-ignored', 'src/'], {});
    assert.equal(selected.command === 'claude' && selected.action === action && 'path' in selected && selected.path, 'src/');
    assert.equal(parseArguments(['claude', action, '--', '-file'], {}).command, 'claude');
    for (const extra of [['--include-ignored'], ['--wat'], ['a', 'b'], ['../other'], ['/etc'], ['.git/config'], ['a/../../b'], ['a\\b']]) assert.throws(() => parseArguments(['claude', action, ...extra], {}));
    assert.deepEqual(parseArguments(['claude', '--', action], {}), { command: 'claude', action: 'run', workspace: undefined, argv: [action] });
  }
  assert.deepEqual(parseArguments(['claude', 'peek', '--changes-only', 'src/'], {}), { command: 'claude', action: 'peek', workspace: undefined, path: 'src/', includeIgnored: false, changesOnly: true, argv: [] });
  assert.throws(() => parseArguments(['claude', 'ls', '--changes-only'], {}), /Usage: juiced claude ls/);
  assert.throws(() => parseArguments(['claude', 'peek', '--changes-only', '--changes-only'], {}), /Usage: juiced claude peek/);
  const literal = parseArguments(['claude', 'peek', '--', '--changes-only'], {});
  assert.equal(literal.command === 'claude' && literal.action === 'peek' && literal.path, '--changes-only');
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

test('listing preserves Git-visible names and types without reading file contents or running clean filters', async t => {
  const f = await fixture(t);
  await rm(join(f.remote, 'docs', 'guide.md'));
  await writeFile(join(f.remote, '.env'), 'ignored\n');
  await symlink('missing-target', join(f.remote, 'broken'));
  await writeFile(join(f.remote, '-literal\nname'), 'untracked\n');
  await writeFile(join(f.remote, 'src', 'staged.ts'), 'staged\n');
  await git(f.remote, ['add', 'src/staged.ts']);
  const before = await state(f.workspace);
  for (const [scope, includeIgnored] of [['', false], ['src', false], ['README.md', false], ['missing', false], ['missing/child', false], ['docs', false], ['broken', false], ['.env', false], ['.env', true], ['', true]] as const) {
    const listing = await captureListing(f.remote, scope, includeIgnored, f.controller.signal);
    validateInspectionListing(listing, scope);
    const snapshot = await f.snapshot(f.remote, scope, includeIgnored);
    assert.equal(listing.kind, snapshot.kind, scope);
    const simple = (entries: typeof listing.entries) => entries.map(({ name, mode }) => ({ name, mode })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(simple(listing.entries), simple(snapshot.entries), scope);
    assert.deepEqual(listing.entry, snapshot.entry && { name: snapshot.entry.name, mode: snapshot.entry.mode }, scope);
  }
  assert.deepEqual(await state(f.workspace), before);
  await writeFile(join(f.remote, '.gitattributes'), 'README.md filter=fail\n');
  await git(f.remote, ['config', 'filter.fail.clean', 'exit 77']);
  await git(f.remote, ['config', 'filter.fail.required', 'true']);
  await assert.rejects(f.snapshot(f.remote), /filter|Unable to inspect/);
  if (process.getuid?.() !== 0) await chmod(join(f.remote, 'README.md'), 0o000);
  try {
    assert.ok((await captureListing(f.remote, '', false, f.controller.signal)).entries.some(entry => entry.name === 'README.md'));
    assert.equal((await captureListing(f.remote, 'README.md', false, f.controller.signal)).kind, 'file');
  } finally { await chmod(join(f.remote, 'README.md'), 0o644); }
  await symlink('../project', join(f.remote, 'outside'));
  await assert.rejects(captureListing(f.remote, 'outside/src', false, f.controller.signal), /symlink ancestor/);
});

test('inspection sessions are stable across scopes, isolated by workspace and binding, and preserved on abort', async () => {
  const ids: string[] = [];
  const command: InspectionCommand = { type: 'inspect', id: randomUUID(), directoryName: 'project', binding: 'a'.repeat(64), scope: '', includeIgnored: false };
  let aborted = false;
  const workspace = (id: string) => ({ selector: { id }, session: (config: { id: string; keepAliveSeconds: number }) => {
    ids.push(config.id); assert.equal(config.keepAliveSeconds, 120);
    return {
      async view() { throw Object.assign(new Error('No view'), { code: 'session_not_found' }); },
      async request() { return { ok: true }; },
      async *stream({ signal }: { signal: AbortSignal }) {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        yield { data: { type: 'inspection-error', id: command.id, message: 'expected failure' } };
      },
      async stop() { assert.fail('A client must never stop the shared session'); },
    };
  } }) as unknown as Parameters<typeof remoteSnapshot>[0];
  const signal = new AbortController().signal;
  for (const [id, changes] of [['wsp_a', {}], ['wsp_a', { scope: 'src', includeIgnored: true }], ['wsp_b', {}], ['wsp_a', { binding: 'b'.repeat(64) }], ['wsp_a', { directoryName: 'other' }]] as const) {
    await assert.rejects(remoteSnapshot(workspace(id), { ...command, ...changes }, signal), /expected failure/);
  }
  assert.equal(ids[0], ids[1]); assert.equal(new Set(ids).size, 4);
  assert.equal(aborted, true);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(remoteSnapshot(workspace('wsp_a'), command, controller.signal), /cancelled/);
});

test('small inventories use one request and validate the inline reply without reading history', async t => {
  const f = await fixture(t), snapshot = await f.snapshot(f.local);
  let requests = 0;
  const workspace = {
    selector: { id: `wsp_${'a'.repeat(32)}` },
    session() { return {
      async request(command: InspectionCommand) { requests++; assert.equal(command.inline, true); return { ok: true, inspection: snapshot }; },
      async view() { assert.fail('Inline inspection must not read the session view'); },
      async *stream() { assert.fail('Inline inspection must not open an event stream'); },
    }; },
  } as unknown as Parameters<typeof remoteSnapshot>[0];
  const command: InspectionCommand = { type: 'inspect', id: randomUUID(), directoryName: 'project', binding: f.repository.binding, scope: '', includeIgnored: false };
  assert.deepEqual(await remoteSnapshot(workspace, command, f.controller.signal), snapshot);
  assert.equal(requests, 1);
  await assert.rejects(remoteSnapshot(workspace, { ...command, scope: 'wrong' }, f.controller.signal), /invalid/);
});

test('large inline fallbacks resume at their tagged boundary and otherwise replay retained output', async t => {
  const f = await fixture(t), snapshot = await f.snapshot(f.local), bytes = Buffer.from(JSON.stringify(snapshot));
  const cursor = { streamId: 'a'.repeat(32), sequence: 7 };
  for (const tagged of [true, false]) {
    const streamed: unknown[] = [];
    const workspace = {
      selector: { id: `wsp_${'a'.repeat(32)}` },
      session() {
        let command: InspectionCommand;
        return {
          async request(value: InspectionCommand) { command = value; return { ok: true }; },
          async view() { return { state: { inspection: 1, ...(tagged ? { streaming: command.id } : {}) }, cursor }; },
          async *stream({ after }: { after?: unknown }) {
            streamed.push(after);
            yield { data: { type: 'inspection-chunk', id: command.id, offset: 0, data: bytes.toString('base64') } };
            yield { data: { type: 'inspection-end', id: command.id, size: bytes.length, sha256: sha256(bytes) } };
          },
        };
      },
    } as unknown as Parameters<typeof remoteSnapshot>[0];
    const command: InspectionCommand = { type: 'inspect', id: randomUUID(), directoryName: 'project', binding: f.repository.binding, scope: '', includeIgnored: false };
    assert.deepEqual(await remoteSnapshot(workspace, command, f.controller.signal), snapshot);
    assert.deepEqual(streamed, [tagged ? cursor : undefined]);
  }
});

test('expired or reset inspection replay retries once without stopping the shared session', async t => {
  const f = await fixture(t), snapshot = await f.snapshot(f.local), bytes = Buffer.from(JSON.stringify(snapshot));
  for (const code of ['event_cursor_expired', 'event_stream_reset']) {
    const configs: { id: string; keepAliveSeconds: number }[] = [];
    let sharedSignal: AbortSignal | undefined;
    const workspace = {
      selector: { id: `wsp_${'a'.repeat(32)}` },
      session(config: { id: string; keepAliveSeconds: number }) {
        configs.push(config); let command: InspectionCommand;
        return {
          async view() { return { cursor: { streamId: 'a'.repeat(32), sequence: 300 } }; },
          async request(value: InspectionCommand) { command = value; return { ok: true }; },
          async *stream({ signal }: { signal: AbortSignal }) {
            if (config.keepAliveSeconds) { sharedSignal = signal; throw Object.assign(new Error(code), { code }); }
            yield { data: { type: 'inspection-chunk', id: command.id, offset: 0, data: bytes.toString('base64') } };
            yield { data: { type: 'inspection-end', id: command.id, size: bytes.length, sha256: sha256(bytes) } };
          },
          async stop() { assert.fail('Recovery must not stop any shared work'); },
        };
      },
    } as unknown as Parameters<typeof remoteSnapshot>[0];
    const command: InspectionCommand = { type: 'inspect', id: randomUUID(), directoryName: 'project', binding: f.repository.binding, scope: '', includeIgnored: false };
    assert.deepEqual(await remoteSnapshot(workspace, command, f.controller.signal), snapshot);
    assert.equal(configs.length, 2); assert.equal(configs[0]!.keepAliveSeconds, 120); assert.equal(configs[1]!.keepAliveSeconds, 0);
    assert.notEqual(configs[0]!.id, configs[1]!.id); assert.equal(sharedSignal?.aborted, true);
  }
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
});

test('submodules and embedded repositories exclude only affected rows and preserve all Git state', async t => {
  const f = await fixture(t);
  await git(f.root, ['clone', '--no-hardlinks', f.remote, join(f.local, 'submodule')]);
  await git(f.local, ['add', 'submodule']);
  await writeFile(join(f.local, 'submodule', 'README.md'), 'dirty nested contents\n');
  await git(f.root, ['clone', '--no-hardlinks', f.local, join(f.remote, 'src', 'embedded')]);
  const before = await Promise.all([state(f.local), state(f.remote)]);
  const local = await f.snapshot(f.local), remote = await f.snapshot(f.remote);
  validateInspectionSnapshot(local, ''); validateInspectionSnapshot(remote, '');
  const comparison = compareInspection(local, remote);
  assert.equal(comparison.rows.find(row => row.name === 'README.md')?.status, 'matching');
  assert.equal(comparison.rows.find(row => row.name === 'submodule')?.status, 'excluded');
  assert.equal(comparison.rows.find(row => row.name === 'src')?.status, 'excluded');
  assert.deepEqual(local.submodules, ['submodule']); assert.deepEqual(remote.submodules, ['src']);
  const options = { localRoot: f.local, remoteRoot: f.remote, workspace: 'chosen', workspaceId: `wsp_${'a'.repeat(32)}`, includeIgnored: false, changesOnly: false, columns: undefined, color: false };
  const view = renderInspection(comparison, options);
  assert.match(view, /submodule\/ \[submodule\]\s+\?/);
  assert.match(view, /src\/ \[contains submodule\]/);
  assert.match(view, /nested Git repository contents are excluded/);
  assert.doesNotMatch(view, /use --include-ignored/);
  for (const [root, scope, name] of [[f.local, '', 'submodule'], [f.local, 'submodule', 'submodule'], [f.remote, 'src', 'embedded'], [f.remote, 'src/embedded', 'embedded']] as const) {
    const listing = await captureListing(root, scope, false, f.controller.signal);
    validateInspectionListing(listing, scope);
    assert.equal((listing.kind === 'file' ? listing.entry : listing.entries.find(entry => entry.name === name))?.mode, '160000');
    assert.match(renderRemoteListing(listing, options), new RegExp(`${name}/ \\[submodule\\]`));
  }
  const selected = await f.snapshot(f.local, 'submodule');
  assert.equal(selected.kind, 'file'); assert.equal(selected.entry?.mode, '160000');
  assert.equal(compareInspection(selected, selected).rows[0]?.status, 'excluded');
  assert.equal((await f.snapshot(f.local, 'README.md')).kind, 'file');
  assert.equal(compareInspection(await f.snapshot(f.local, '', true), remote).rows.find(row => row.name === 'submodule')?.status, 'excluded');
  for (const capture of [captureInspection, captureListing]) {
    await assert.rejects(capture(f.local, 'submodule/README.md', false, f.controller.signal), /nested Git repository "submodule"/);
    await assert.rejects(capture(f.remote, 'src/embedded/README.md', false, f.controller.signal), /nested Git repository "src\/embedded"/);
  }
  assert.deepEqual(await Promise.all([state(f.local), state(f.remote)]), before);

  // An uninitialized gitlink still bounds inspection, even without a .git entry.
  await rm(join(f.local, 'submodule', '.git'), { recursive: true });
  for (const capture of [captureInspection, captureListing]) {
    const selected = await capture(f.local, 'submodule', false, f.controller.signal);
    assert.equal(selected.entry?.mode, '160000');
    await assert.rejects(capture(f.local, 'submodule/README.md', false, f.controller.signal), /nested Git repository "submodule"/);
  }
  // A working file replacing a gitlink must be listed and compared as a file.
  await rm(join(f.local, 'submodule'), { recursive: true });
  await writeFile(join(f.local, 'submodule'), 'replacement\n');
  for (const capture of [captureInspection, captureListing]) {
    const selected = await capture(f.local, 'submodule', false, f.controller.signal);
    assert.equal(selected.entry?.mode, '100644');
  }
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
  const base = { localRoot: f.local, remoteRoot: f.remote, workspace: 'chosen', workspaceId: `wsp_${'a'.repeat(32)}`, includeIgnored: false, color: false };
  const unstyle = (value: string) => value.replace(/\u001b\[[\d;]*m/g, '');
  for (const columns of [80, 40, 20]) {
    const view = renderInspection(comparison, { ...base, changesOnly: false, columns });
    assert.ok(view.split('\n').every(line => stringWidth(line) <= columns), `${columns}-column overflow`);
    assert.ok(!view.includes('\u001b'));
    assert.ok(!view.includes('generated-'));
    // Styling is applied after the width maths, so colour never moves a column.
    const styled = renderInspection(comparison, { ...base, changesOnly: false, columns, color: true });
    assert.ok(styled.split('\n').every(line => stringWidth(line) <= columns), `${columns}-column styled overflow`);
    assert.equal(unstyle(styled), view);
    const listing = renderRemoteListing(comparison.local, { ...base, columns });
    assert.ok(listing.split('\n').every(line => stringWidth(line) <= columns));
    assert.equal(unstyle(renderRemoteListing(comparison.local, { ...base, columns, color: true })), listing);
    assert.ok(!listing.includes('\u001b'));
    assert.match(listing.replace(/\n\s*/g, ''), /\\u000a\\u001b/);
  }
  const peek = renderInspection(comparison, { ...base, changesOnly: false, columns: undefined });
  const changes = renderInspection(comparison, { ...base, changesOnly: true, columns: undefined });
  const listing = renderRemoteListing(comparison.remote, { ...base, columns: undefined });
  assert.match(peek, /README\.md\s+=\s+README\.md/);
  assert.doesNotMatch(changes, /README\.md\s+=/);
  assert.equal(peek.trim().split('\n').at(-2), changes.trim().split('\n').at(-2));
  assert.match(peek, /\\u000a\\u001b/);
  // The counts legend names the glyphs the table uses and omits statuses no row has.
  assert.match(peek, /^\s+= 3 matching\s+! 1 different\s+L 1 local only$/m);
  assert.doesNotMatch(peek, /remote only/);
  assert.match(peek, /^\s+LOCAL\s+REMOTE$/m);
  // Terminals too narrow for two columns name each entry once and annotate the difference.
  const narrow = renderInspection(comparison, { ...base, changesOnly: false, columns: 20 });
  assert.doesNotMatch(narrow, /LOCAL\s+REMOTE/);
  assert.match(narrow, /^\s+! src\/$/m);
  assert.match(narrow, /^\s+only in local$/m);
  assert.match(listing, /^\s+README\.md$/m);
  assert.match(listing, /^\s+src\/$/m);
  assert.doesNotMatch(listing, /Local|HEAD|matching|different|generated-/);
  const matching = compareInspection(comparison.remote, comparison.remote);
  assert.match(renderInspection(matching, { ...base, changesOnly: false, columns: undefined }), /README\.md\s+=\s+README\.md/);
  assert.match(renderInspection(matching, { ...base, changesOnly: true, columns: undefined }), /No differences observed/);
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
  const boundaries = new Map<string, number>();
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
      if (operation.type === 'view') {
        const sequence = boundaries.get(id);
        return sequence === undefined ? Response.json({ error: { code: 'session_view_not_found' } }, { status: 404 }) : Response.json({ protocolVersion: 2, workspaceId, sessionId: id, revision: '1', updatedAt: new Date().toISOString(), state: { inspection: 1 }, cursor: { streamId: 'a'.repeat(32), sequence } });
      }
      if (operation.type === 'request') {
        assert.equal(operation.message.type, 'inspect');
        const command = operation.message as InspectionCommand;
        if (command.inline) {
          try { return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true, inspection: await captureRemoteInspection(command, f.controller.signal, f.workspace) } }); }
          catch (error) { return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: false, error: (error as Error).message } }); }
        }
        const history = histories.get(id) ?? []; histories.set(id, history);
        void inspectRemote(command, { async send(data) {
          history.push({ data, sessionId: id, messageId: body.id, cursor: { streamId: 'a'.repeat(32), sequence: history.length + 1 }, createdAt: new Date() }); emitted.emit(id);
        } }, f.controller.signal, f.workspace).then(() => boundaries.set(id, history.length)).catch(error => emitted.emit('error', error));
        return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true } });
      }
      if (operation.type === 'stream') {
        let index = operation.after?.sequence ?? 0;
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
  const options = { action: 'peek' as const, path: '.', includeIgnored: false, changesOnly: false };
  assert.equal(await inspectWorkspace(app, f.local, options, f.controller.signal, stdout), 2);
  assert.deepEqual(calls.map(call => call.command.type), ['workspace.inspect']);
  calls.length = 0; exists = true; text = '';
  const before = await state(f.workspace);
  assert.equal(await inspectWorkspace(app, f.local, options, f.controller.signal, stdout), 0);
  assert.match(text, /src\/\s+!\s+src\//);
  assert.deepEqual(calls.map(call => call.command.type), ['workspace.inspect', 'request']);
  const inspectionSession = calls.find(call => call.command.type === 'request')!.session!.id;
  assert.match(inspectionSession, /^ses_inspect_[a-f0-9]{32}$/);
  assert.equal(calls.filter(call => call.command.type === 'stop').length, 0);
  assert.deepEqual(await state(f.workspace), before);
  // Width and colour follow the real stdout: a terminal gets both, NO_COLOR or a dumb terminal gets neither.
  const environment = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  t.after(() => { for (const [key, value] of Object.entries(environment)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const [term, noColor, colored] of [['xterm-256color', undefined, true], ['xterm-256color', '1', false], ['dumb', undefined, false]] as const) {
    process.env.TERM = term;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    const terminal = Object.assign(new PassThrough(), { isTTY: true, columns: 100 }); let styled = '';
    terminal.on('data', bytes => styled += String(bytes));
    assert.equal(await inspectWorkspace(app, f.local, options, f.controller.signal, terminal), 0);
    assert.match(styled, /LOCAL\s+REMOTE/);
    assert.equal(styled.includes('\u001b['), colored, `${term} ${noColor ?? 'colour'} styling`);
  }
  await writeFile(join(f.local, 'local-only.txt'), 'local\n');
  await writeFile(join(f.remote, 'remote-only.txt'), 'remote\n');
  const remoteBefore = await state(f.workspace);
  if (process.getuid?.() !== 0) await chmod(join(f.local, 'README.md'), 0o000);
  text = ''; calls.length = 0;
  try {
    assert.equal(await inspectWorkspace(app, f.local, { action: 'ls', path: '.', includeIgnored: false }, f.controller.signal, stdout), 0);
    assert.match(text, /^\s+remote-only\.txt$/m);
    assert.match(text, /^\s+README\.md$/m);
    assert.doesNotMatch(text, /local-only|Local|HEAD|matching|different/);
    assert.equal(calls.find(call => call.command.type === 'request')!.session!.id, inspectionSession);
    assert.ok(calls.some(call => call.command.type === 'request' && call.command.message.type === 'inspect' && call.command.message.mode === 'listing'));
    assert.deepEqual(calls.map(call => call.command.type), ['workspace.inspect', 'request']);
    assert.equal(calls.filter(call => call.command.type === 'stop').length, 0);
    assert.deepEqual(await state(f.workspace), remoteBefore);
  } finally { await chmod(join(f.local, 'README.md'), 0o644); }
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
      view: async () => { throw Object.assign(new Error('No view'), { code: 'session_view_not_found' }); },
      async *stream() { for (const data of events) yield { data }; },
    };
    await assert.rejects(remoteSnapshot({ selector: { id: `wsp_${'a'.repeat(32)}` }, session: () => session } as unknown as Parameters<typeof remoteSnapshot>[0], command, f.controller.signal), InspectionIncomplete);
    assert.equal(stopped, false);
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
