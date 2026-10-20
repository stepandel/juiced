import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import type { WorkspaceSync, WorkspaceSyncOptions, WorkspaceSyncStatus } from '@cantelop/sdk';
import { syncFiles } from '../src/file-sync.js';
import { git } from '../src/git.js';
import { selectProject } from '../src/project.js';
import { until as poll } from './fixtures/wait.js';

const until = (check: () => boolean) => poll(check, { attempts: 400, message: 'File sync did not reach the expected state' });

async function fixture(t: test.TestContext) {
  const local = await mkdtemp(join(tmpdir(), 'juiced-file-sync-'));
  t.after(() => rm(local, { recursive: true, force: true }));
  const project = await selectProject(local), controller = new AbortController();
  let output = '', stopped = 0;
  const stderr = new Writable({ write(bytes, _encoding, callback) { output += bytes; callback(); } });
  const sync: WorkspaceSync = {
    remoteDirectory: project.remoteDirectory,
    async ready() {}, async flush() { throw new Error('Unexpected extra reconciliation'); },
    status() { return { state: 'synced', writable: true, conflicts: [] }; },
    async stop() { stopped++; },
  };
  const workspace = { async sync(options: WorkspaceSyncOptions) {
    assert.equal(options.localDirectory, project.localDirectory); assert.equal(options.remoteDirectory, project.directoryName);
    assert.deepEqual(options.ignore, ['dist', 'coverage']); assert.equal(options.signal, controller.signal);
    return sync;
  } };
  return { local, project, controller, sync, workspace, stderr, get output() { return output; }, get stopped() { return stopped; } };
}

test('one-time file sync waits for reconciliation then releases the adapter', async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.sync.ready = () => new Promise<void>(resolve => { release = resolve; });
  const running = syncFiles(f.workspace, f.project, false, f.controller.signal, f.stderr);
  await until(() => Boolean(release));
  assert.equal(f.stopped, 0); assert.doesNotMatch(f.output, /Files synchronized/);
  release(); await running;
  assert.match(f.output, /Files synchronized/); assert.equal(f.stopped, 1);
});

test('watch runs until cancelled and always releases its adapter without a final transfer', async t => {
  const f = await fixture(t);
  const running = syncFiles(f.workspace, f.project, true, f.controller.signal, f.stderr);
  const rejected = assert.rejects(running, /abort/i);
  await until(() => f.output.includes('Press Ctrl+C'));
  assert.equal(f.stopped, 0);
  f.controller.abort(); await rejected;
  assert.equal(f.stopped, 1);
});

test('startup failures and read-only workspaces release the adapter without reporting success', async t => {
  for (const gated of [false, true]) {
    const f = await fixture(t);
    if (gated) f.sync.status = () => ({ state: 'synced', writable: false, conflicts: [] });
    else f.sync.ready = async () => { throw Object.assign(new Error('conflict'), { code: 'sync_conflict' }); };
    await assert.rejects(syncFiles(f.workspace, f.project, false, f.controller.signal, f.stderr), gated ? /uploads are disabled/ : /Both copies were preserved/);
    assert.equal(f.stopped, 1); assert.doesNotMatch(f.output, /Files synchronized/);
  }
});

test('watch stops on conflicts or adapter errors after initial reconciliation', async t => {
  for (const state of ['conflict', 'error', 'stopped'] as const) {
    const f = await fixture(t); let reads = 0;
    f.sync.status = (): WorkspaceSyncStatus => ++reads === 1 ? { state: 'synced', writable: true, conflicts: [] }
      : { state, conflicts: [], ...(state === 'error' ? { error: 'sync_helper_unavailable' } : {}) };
    await assert.rejects(syncFiles(f.workspace, f.project, true, f.controller.signal, f.stderr), state === 'conflict' ? /Both copies were preserved/ : state === 'error' ? /Reinstall Juiced/ : /stopped unexpectedly/);
    assert.equal(f.stopped, 1);
  }
});

test('Git repositories and pre-cancelled commands never start file sync', async t => {
  const f = await fixture(t); let started = false;
  const workspace = { async sync() { started = true; return f.sync; } };
  await git(f.local, ['init', '-b', 'main']);
  await git(f.local, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'base']);
  await assert.rejects(syncFiles(workspace, f.project, true, f.controller.signal, f.stderr), /Use juiced claude sync --to-workspace/);
  f.controller.abort();
  await assert.rejects(syncFiles(workspace, f.project, false, f.controller.signal, f.stderr), /abort/i);
  assert.equal(started, false);
});
