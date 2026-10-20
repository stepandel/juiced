import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isENOENT, writeFileAtomic } from '../src/fs-util.js';

test('writeFileAtomic replaces privately and leaves no temporary behind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'juiced-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  await writeFileAtomic(path, 'one');
  await Promise.all([writeFileAtomic(path, 'two'), writeFileAtomic(path, 'three')]);
  assert.match(await readFile(path, 'utf8'), /^(two|three)$/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['state.json']);

  await assert.rejects(writeFileAtomic(path, 'four', { signal: AbortSignal.abort() }));
  assert.equal(await readFile(path, 'utf8').then(text => text !== 'four'), true);
  assert.deepEqual(await readdir(directory), ['state.json']);
  await assert.rejects(writeFileAtomic(join(directory, 'missing', 'x'), 'x'), isENOENT);
  assert.equal(isENOENT(undefined), false);
});
