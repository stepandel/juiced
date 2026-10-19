import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProject } from '../src/project.js';
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
