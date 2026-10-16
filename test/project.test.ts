import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProject, synchronizeProject } from '../src/project.js';
import { validProjectName } from '../src/project-name.js';

test('canonical directories select stable, separate workspaces and retain the local basename', async t => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-pairing-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'a', 'My Project'), { recursive: true }); await mkdir(join(root, 'b', 'My Project'), { recursive: true });
  await symlink(join(root, 'a', 'My Project'), join(root, 'alias'));
  const first = await selectProject(join(root, 'a', 'My Project'));
  assert.deepEqual(await selectProject(join(root, 'alias')), first);
  assert.equal(first.localDirectory, await realpath(join(root, 'a', 'My Project')));
  assert.equal(first.remoteDirectory, '/workspace/My Project');
  assert.match(first.workspace, /^my-project-[a-f0-9]{16}$/);
  assert.notEqual((await selectProject(join(root, 'b', 'My Project'))).workspace, first.workspace);
  assert.equal((await selectProject(join(root, 'alias'), 'chosen')).workspace, 'chosen');
});

test('project names cannot overlap account state or select another path', () => {
  for (const name of ['.claude', '.local', '', '../secret', 'a/b', 'a\\b', 'NODE_MODULES', 'x\x1b', 'trailing.']) assert.equal(validProjectName(name), false);
  assert.equal(validProjectName('My Project'), true);
});

test('startup waits for initial reconciliation and shutdown flushes before releasing the handle', async () => {
  const events: string[] = []; let unblock!: () => void;
  const project = { localDirectory: '/local/project', directoryName: 'project', remoteDirectory: '/workspace/project', workspace: 'project-hash' };
  const started = synchronizeProject({ async sync(options) {
    assert.equal(options.remoteDirectory, 'project'); assert.deepEqual(options.ignore, ['dist', 'coverage']);
    return { remoteDirectory: '/workspace/project', async ready() { events.push('ready'); await new Promise<void>(resolve => unblock = resolve); },
      async flush() { events.push('flush'); }, async stop() { events.push('stop'); }, status() { return { state: 'synced', conflicts: [] }; } };
  } }, project, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['ready']);
  unblock(); const sync = await started; events.push('agent may start'); await sync.close();
  assert.deepEqual(events, ['ready', 'agent may start', 'flush', 'stop']);
});

test('a hosted write gate releases the handle and never completes agent startup', async () => {
  let stopped = false;
  await assert.rejects(synchronizeProject({ async sync() { return {
    remoteDirectory: '/workspace/project', async ready() { throw Object.assign(new Error('gate'), { code: 'sync_writes_not_enabled' }); }, async flush() {},
    async stop() { stopped = true; }, status() { return { state: 'error', error: 'sync_writes_not_enabled', conflicts: [] }; },
  }; } }, { localDirectory: '/local/project', directoryName: 'project', remoteDirectory: '/workspace/project', workspace: 'project-hash' }, new AbortController().signal), /Hosted uploads are disabled/);
  assert.equal(stopped, true);
});


test('an empty directory still requires remote writes before agent startup', async () => {
  let stopped = false;
  await assert.rejects(synchronizeProject({ async sync() { return {
    remoteDirectory: '/workspace/project', async ready() {}, async flush() {}, async stop() { stopped = true; },
    status() { return { state: 'synced', writable: false, conflicts: [] }; },
  }; } }, { localDirectory: '/local/project', directoryName: 'project', remoteDirectory: '/workspace/project', workspace: 'project-hash' }, new AbortController().signal), /Hosted uploads are disabled/);
  assert.equal(stopped, true);
});
