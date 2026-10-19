// Design evidence for docs/workspace-inspection.md, not a CLI implementation.
// Run with: node --import tsx scripts/probe-workspace-inspection.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CantelopClient } from '@cantelop/sdk';
import { createGitRuntime } from '../src/runtime/git.ts';

const execute = promisify(execFile);
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--output')) throw new Error('Usage: probe-workspace-inspection.mjs [--output FILE]');
const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-inspection-probe-')));
const local = join(root, 'local'), remote = join(root, 'remote');
const git = async (cwd, argv) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...argv], {
  encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
})).stdout;
const splitPaths = bytes => bytes.subarray(0, bytes.length ? bytes.length - 1 : 0).toString('utf8').split('\0').filter(Boolean);
const candidates = async cwd => new Set(splitPaths(await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])));
const stamp = info => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const locate = async path => {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
};

// A small experiment with hashing and mutation checks; no production protocol,
// path traversal, pagination, or end-to-end consistency guarantee is implied.
async function observe(path, afterFirstRead) {
  let file;
  try {
    const before = await locate(path);
    if (!before) return { type: 'absent' };
    if (before.isSymbolicLink()) {
      const target = await readlink(path, { encoding: 'buffer' });
      if (stamp(before) !== stamp(await lstat(path, { bigint: true }))) return { type: 'unknown', reason: 'changed during inspection' };
      return { type: 'symlink', target: target.toString('hex') };
    }
    if (!before.isFile()) return { type: 'unknown', reason: 'unsupported entry' };
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (stamp(before) !== stamp(await file.stat({ bigint: true }))) return { type: 'unknown', reason: 'changed during inspection' };
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(1024);
    let first = true;
    while (true) {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      hash.update(bytes.subarray(0, bytesRead));
      if (first && afterFirstRead) await afterFirstRead();
      first = false;
    }
    const after = await file.stat({ bigint: true });
    const entry = await locate(path);
    if (!entry || stamp(before) !== stamp(after) || stamp(after) !== stamp(entry)) return { type: 'unknown', reason: 'changed during inspection' };
    return { type: 'file', executable: Boolean(before.mode & 0o100n), digest: hash.digest('hex') };
  } catch (error) { return { type: 'unknown', reason: error.code ?? error.message }; }
  finally { await file?.close(); }
}

function classify(a, b) {
  if (a.type === 'unknown' || b.type === 'unknown') return 'indeterminate';
  if (a.type === 'absent' && b.type === 'absent') return 'omit';
  if (a.type === 'absent') return 'remote only';
  if (b.type === 'absent') return 'local only';
  if (a.type !== b.type) return 'different type';
  if (a.type === 'symlink') return a.target === b.target ? 'matching' : 'different target';
  if (a.digest !== b.digest) return 'different contents';
  return a.executable === b.executable ? 'matching' : 'different executable bit';
}

// Independent oracle: read whole byte buffers, without observe(), its hashes,
// or classify(). Explicit expected results below provide a second check.
async function oracle(a, b) {
  const left = await locate(a), right = await locate(b);
  if (!left && !right) return 'omit';
  if (!left) return 'remote only';
  if (!right) return 'local only';
  if (left.isSymbolicLink() !== right.isSymbolicLink()) return 'different type';
  if (left.isSymbolicLink()) return (await readlink(a, { encoding: 'buffer' })).equals(await readlink(b, { encoding: 'buffer' })) ? 'matching' : 'different target';
  let equal;
  try { equal = (await readFile(a)).equals(await readFile(b)); }
  catch (error) { if (error.code === 'EACCES') return 'indeterminate'; throw error; }
  if (!equal) return 'different contents';
  return Boolean(left.mode & 0o100n) === Boolean(right.mode & 0o100n) ? 'matching' : 'different executable bit';
}

async function tree(path, prefix = '') {
  const rows = [];
  for (const name of (await readdir(path)).sort()) {
    const absolute = join(path, name), relative = prefix + name;
    const info = await lstat(absolute, { bigint: true });
    if (info.isDirectory()) rows.push([relative + '/', stamp(info)], ...await tree(absolute, relative + '/'));
    else if (info.isSymbolicLink()) rows.push([relative, stamp(info), (await readlink(absolute, { encoding: 'buffer' })).toString('hex')]);
    else {
      let bytes;
      try { bytes = (await readFile(absolute)).toString('hex'); }
      catch (error) { if (error.code !== 'EACCES') throw error; bytes = 'EACCES'; }
      rows.push([relative, stamp(info), bytes]);
    }
  }
  return rows;
}

try {
  await mkdir(local);
  await git(local, ['init', '-b', 'main']);
  await git(local, ['config', 'user.name', 'Inspection Probe']);
  await git(local, ['config', 'user.email', 'probe@example.test']);
  await git(local, ['config', 'core.fileMode', 'true']);
  await writeFile(join(local, '.gitignore'), '.env\nignored/\ntracked-ignored.txt\n');
  const base = {
    'same.txt': 'same\n', 'changed.txt': 'base\n', 'staging.txt': 'worktree\n',
    'deleted-local.txt': 'base\n', 'deleted-remote.txt': 'base\n', 'both-deleted.txt': 'base\n',
    'mode.sh': '#!/bin/sh\n', 'group-mode.sh': '#!/bin/sh\n', 'kind': 'regular\n',
    'binary.bin': Buffer.from([0, 1, 2, 255]), 'unreadable.txt': 'private\n',
  };
  for (const [name, bytes] of Object.entries(base)) await writeFile(join(local, name), bytes);
  await writeFile(join(local, 'tracked-ignored.txt'), 'tracked despite ignore\n');
  await symlink('missing-a', join(local, 'link'));
  await symlink('../outside', join(local, 'outside-link'));
  await writeFile(join(root, 'outside'), 'target contents never hashed\n');
  await git(local, ['add', '.']);
  await git(local, ['add', '-f', 'tracked-ignored.txt']);
  await git(local, ['commit', '-m', 'inspection baseline']);
  await git(root, ['clone', '--no-hardlinks', local, remote]);
  await git(remote, ['config', 'core.fileMode', 'true']);

  await writeFile(join(local, 'changed.txt'), 'left\n');
  await writeFile(join(remote, 'changed.txt'), 'rght\n');
  const fixedTime = new Date('2026-10-19T00:00:00Z');
  for (const cwd of [local, remote]) await utimes(join(cwd, 'changed.txt'), fixedTime, fixedTime);
  for (const [cwd, staged] of [[local, 'staged local\n'], [remote, 'staged remote\n']]) {
    await writeFile(join(cwd, 'staging.txt'), staged);
    await git(cwd, ['add', 'staging.txt']);
    await writeFile(join(cwd, 'staging.txt'), base['staging.txt']);
    await rm(join(cwd, 'both-deleted.txt'));
    await writeFile(join(cwd, '.env'), 'ignored\n');
    await writeFile(join(cwd, 'ignored-on-remote.txt'), 'present on both\n');
    await writeFile(join(cwd, 'new\nname\t\u001b[31m.txt'), 'literal filename\n');
  }
  await writeFile(join(remote, '.git', 'info', 'exclude'), 'ignored-on-remote.txt\n');
  await rm(join(local, 'deleted-local.txt'));
  await rm(join(remote, 'deleted-remote.txt'));
  await chmod(join(local, 'mode.sh'), 0o755);
  await chmod(join(local, 'group-mode.sh'), 0o654);
  await rm(join(remote, 'kind')); await symlink('same.txt', join(remote, 'kind'));
  await rm(join(remote, 'link')); await symlink('missing-b', join(remote, 'link'));
  await writeFile(join(remote, 'binary.bin'), Buffer.from([0, 1, 3, 255]));
  await writeFile(join(local, 'local-new.txt'), 'local\n');
  await writeFile(join(remote, 'remote-new.txt'), 'remote\n');
  const canCheckPermissions = typeof process.getuid === 'function' && process.getuid() !== 0;
  if (canCheckPermissions) await chmod(join(local, 'unreadable.txt'), 0o000);

  const before = await Promise.all([tree(local), tree(remote)]);
  const localPaths = await candidates(local), remotePaths = await candidates(remote);
  assert.equal(localPaths.has('ignored-on-remote.txt'), true);
  assert.equal(remotePaths.has('ignored-on-remote.txt'), false);
  assert.equal(localPaths.has('.env') || remotePaths.has('.env'), false);
  assert.equal(localPaths.has('tracked-ignored.txt') && remotePaths.has('tracked-ignored.txt'), true);
  const expected = {
    '.gitignore': 'matching', 'same.txt': 'matching', 'changed.txt': 'different contents',
    'staging.txt': 'matching', 'deleted-local.txt': 'remote only', 'deleted-remote.txt': 'local only',
    'both-deleted.txt': 'omit', 'mode.sh': 'different executable bit', 'group-mode.sh': 'matching',
    'kind': 'different type', 'binary.bin': 'different contents', 'link': 'different target',
    'outside-link': 'matching', 'tracked-ignored.txt': 'matching', 'ignored-on-remote.txt': 'matching',
    'new\nname\t\u001b[31m.txt': 'matching', 'local-new.txt': 'local only', 'remote-new.txt': 'remote only',
    'unreadable.txt': canCheckPermissions ? 'indeterminate' : 'matching',
  };
  const rows = [];
  for (const name of [...new Set([...localPaths, ...remotePaths])].sort()) {
    const a = join(local, name), b = join(remote, name);
    const status = classify(await observe(a), await observe(b));
    assert.equal(status, await oracle(a, b), name);
    assert.equal(status, expected[name], name);
    rows.push({ path: name, status });
  }
  assert.equal(rows.length, Object.keys(expected).length);
  assert.equal((await git(local, ['diff', '--raw', '--', 'group-mode.sh'])).length, 0);
  assert.deepEqual(await Promise.all([tree(local), tree(remote)]), before);

  const racing = join(root, 'racing');
  await writeFile(racing, Buffer.alloc(8192, 1));
  const prior = await lstat(racing);
  const changing = await observe(racing, async () => {
    await writeFile(racing, Buffer.alloc(8192, 2));
    await utimes(racing, prior.atime, prior.mtime);
  });
  assert.deepEqual(changing, { type: 'unknown', reason: 'changed during inspection' });

  // Actual status handler on an absent project, with a recording database.
  // This proves why the new observation path cannot call existing status().
  const statusRoot = join(root, 'status-workspace'); await mkdir(statusRoot);
  const sql = [];
  const record = async statement => { sql.push(typeof statement === 'string' ? statement : statement.sql); return { rows: [], rowsAffected: 1 }; };
  const db = { execute: record, transaction: async () => ({ execute: record, commit: async () => {}, close() {} }) };
  const runtime = createGitRuntime({ signal: new AbortController().signal, session: { id: 'probe', keepAliveSeconds: 120 }, env: {}, database: async () => db }, statusRoot);
  assert.deepEqual(await runtime.handle({ type: 'git', action: 'status', directoryName: 'project', binding: 'a'.repeat(64) }), { status: { initialized: false } });
  assert.deepEqual(await readdir(statusRoot), ['.juiced']);
  assert.ok((await lstat(join(statusRoot, '.juiced', 'project', 'transfers'))).isDirectory());
  assert.ok(sql.some(value => value.startsWith('INSERT')));
  assert.ok(sql.some(value => value.startsWith('DELETE')));

  // Exercise the installed SDK's real serialization without a hosted workspace.
  // These are capability checks, not integration tests of the proposed CLI.
  const calls = [];
  let workspaceExists = false;
  const workspaceId = `wsp_${'b'.repeat(32)}`;
  const app = new CantelopClient().app({ name: 'inspection-probe', runtime: { receive() {} }, connection: {
    async fetch(request) {
      const body = await request.json(); calls.push(body);
      if (body.command.type === 'workspace.inspect') return Response.json({ protocolVersion: 2, workspace: workspaceExists ? {
        id: workspaceId, slug: 'chosen', app_id: `app_${'c'.repeat(32)}`, hostname: 'chosen.inspection-probe.cantelop.dev',
        created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z',
      } : null });
      assert.equal(body.command.type, 'request');
      assert.deepEqual(body.workspace, { id: workspaceId });
      return Response.json({ protocolVersion: 2, id: body.id, reply: { ok: true } });
    },
  } });
  assert.equal(await app.workspace({ slug: 'chosen' }).inspect(), undefined);
  assert.equal(calls.length, 1); assert.equal(calls[0].session, null);
  assert.equal(calls[0].command.type, 'workspace.inspect');
  workspaceExists = true;
  const existing = await app.workspace({ slug: 'chosen' }).inspect();
  await app.workspace({ id: existing.id }).session().request({ type: 'fixture-observation' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.command.type !== 'workspace.resolve'));

  const sourceCommit = (await git(fileURLToPath(new URL('..', import.meta.url)), ['rev-parse', 'HEAD'])).toString().trim();
  const report = {
    purpose: 'Workspace inspection design evidence; the proposed CLI commands are not implemented by this probe.',
    sourceCommit, node: process.version, platform: process.platform,
    git: (await execute('git', ['--version'])).stdout.trim(),
    candidatePaths: rows.length, displayedRows: rows.filter(row => row.status !== 'omit').length,
    oracleAgrees: true, worktreesAndGitMetadataUnchanged: true,
    permissionFailureChecked: canCheckPermissions,
    ignoreAsymmetry: { localCandidate: true, remoteCandidate: false, actualStatus: 'matching' },
    sameSizeAndMtimeDifferingContentsChecked: true,
    concurrentWriteWithRestoredMtime: changing,
    currentStatusSideEffects: { created: ['.juiced/project/transfers'], leaseInsert: true, leaseDelete: true },
    sdkCapabilityChecks: { absentLookupWithoutSession: true, requestUsesInspectedCanonicalId: true, provisionCalls: 0, transport: 'recording connection; no hosted requests' },
    remainingImplementationChecks: ['CLI preflight wiring and deletion races', 'inspection transport bounds and failures', 'filesystem containment and directory type conflicts', 'terminal layout rendering', 'deployed runtime integration'],
    rows,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (args.length) await writeFile(args[1], json);
  else process.stdout.write(json);
} finally { await rm(root, { recursive: true, force: true }); }
