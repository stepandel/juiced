import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveSettings } from '../src/runtime/settings.js';
import { validateSavedSettings, type SavedSettings } from '../src/settings.js';

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'juiced-settings-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, '.claude', 'settings.json');
  return { workspace, path, signal: new AbortController().signal, read: async () => JSON.parse(await readFile(path, 'utf8')) };
}

test('workspace defaults survive independent saves and preserve unrelated Claude settings and rules', async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, '.claude'));
  const original = { permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, hooks: { Stop: [] }, env: { EXAMPLE: 'keep' } };
  await writeFile(f.path, JSON.stringify(original));
  await saveSettings(f.workspace, { model: 'provider.model', permissionMode: 'acceptEdits' }, f.signal);
  await saveSettings(f.workspace, { effortLevel: 'high', outputStyle: 'Learning', fastMode: false }, f.signal);
  assert.deepEqual(await f.read(), { ...original, permissions: { ...original.permissions, defaultMode: 'acceptEdits' }, model: 'provider.model', effortLevel: 'high', outputStyle: 'Learning', fastMode: false });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(f.workspace, '.claude')), ['settings.json']);
  const other = await fixture(t);
  await saveSettings(other.workspace, { model: 'default', permissionMode: 'default' }, other.signal);
  assert.equal((await f.read()).model, 'provider.model');
  assert.deepEqual(await other.read(), { model: 'default', permissions: { defaultMode: 'default' } });
});

test('concurrent sessions save different settings without losing either choice', async t => {
  const f = await fixture(t);
  await Promise.all([
    saveSettings(f.workspace, { model: 'sonnet' }, f.signal),
    saveSettings(f.workspace, { permissionMode: 'plan' }, f.signal),
    saveSettings(f.workspace, { fastMode: false }, f.signal),
  ]);
  assert.deepEqual(await f.read(), { model: 'sonnet', permissions: { defaultMode: 'plan' }, fastMode: false });
});

test('malformed settings are preserved and a failed save releases the lock', async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, '.claude'));
  for (const original of ['{invalid', 'null', '[]', '{"permissions":false}']) {
    await writeFile(f.path, original);
    await assert.rejects(saveSettings(f.workspace, { permissionMode: 'plan' }, f.signal));
    assert.equal(await readFile(f.path, 'utf8'), original);
    assert.deepEqual(await readdir(join(f.workspace, '.claude')), ['settings.json']);
  }
  await writeFile(f.path, '{}');
  await saveSettings(f.workspace, { permissionMode: 'default' }, f.signal);
  assert.deepEqual(await f.read(), { permissions: { defaultMode: 'default' } });
});

test('only supported personal defaults can be saved and cancellation leaves the original file intact', async t => {
  for (const settings of [null, [], {}, { hooks: {} }, { permissionMode: 'bypassPermissions' }, { model: '--model extra' }, { fastMode: 'false' }, { effortLevel: 'bad level' }, { outputStyle: '\x1b[31m' }]) {
    assert.throws(() => validateSavedSettings(settings as SavedSettings), /Invalid saved settings/);
  }
  const f = await fixture(t);
  await saveSettings(f.workspace, { model: 'sonnet' }, f.signal);
  await assert.rejects(saveSettings(f.workspace, { model: 'opus' }, AbortSignal.abort()));
  assert.equal((await f.read()).model, 'sonnet');
});
