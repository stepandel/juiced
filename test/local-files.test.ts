import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { LocalFiles } from '../src/local-files.js';
import { LOCAL_LIST_PAGE, MAX_LOCAL_FILE_BYTES, type LocalFilesRequest } from '../src/local-files-protocol.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-file-capture-')));
  const files = new LocalFiles(root), requests: LocalFilesRequest[] = [];
  t.after(async () => { for (const request of requests) await files.discard(request.id); await rm(root, { recursive: true, force: true }); });
  const pull = (paths: string[]): LocalFilesRequest => {
    const request: LocalFilesRequest = { id: randomUUID(), kind: 'files', action: 'pull', summary: 'Selected local files', expiresAt: Date.now() + 60_000, paths, destination: '.' };
    requests.push(request); return request;
  };
  return { root, files, pull, signal: new AbortController().signal };
}

test('file capture rejects oversize files, large selections, and symlink descendants', async t => {
  const f = await fixture(t);
  const big = await open(join(f.root, 'large'), 'wx');
  await big.truncate(MAX_LOCAL_FILE_BYTES + 1); await big.close();
  await assert.rejects(f.files.prepare(f.pull(['large']), f.signal), /16 MiB/);
  await mkdir(join(f.root, 'many'));
  for (let i = 0; i < 257; i++) await writeFile(join(f.root, 'many', String(i)), '');
  await assert.rejects(f.files.prepare(f.pull(['many']), f.signal), /256 files/);
  await mkdir(join(f.root, 'selected')); await symlink(join(f.root, 'large'), join(f.root, 'selected', 'link'));
  await assert.rejects(f.files.prepare(f.pull(['selected']), f.signal), /Symlink/);
});

test('empty files transfer and cancelled or discarded captures cannot send data', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.empty'), '');
  const request = f.pull(['.empty']);
  const preview = await f.files.prepare(request, f.signal); assert.equal(preview.bytes, 0);
  const calls: unknown[] = [];
  const send = async (command: unknown) => { calls.push(command); return { ok: true as const }; };
  await f.files.send(request, f.signal, send);
  assert.equal(calls.length, 1, 'An empty file needs its manifest, with no chunks');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.files.send(request, controller.signal, send), /abort/i);
  await f.files.discard(request.id);
  await assert.rejects(f.files.send(request, f.signal, send), /no longer available/);
  await assert.rejects(f.files.prepare(f.pull(['.empty']), controller.signal), /abort/i);
  assert.equal(calls.length, 1);
});

test('local listings hide dotfiles by default and never follow an explicitly selected symlink', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.hidden'), 'private'); await writeFile(join(f.root, 'visible'), 'public');
  await symlink(f.root, join(f.root, 'link'));
  const request: LocalFilesRequest = { id: randomUUID(), kind: 'files', action: 'list', summary: 'Browse local names', expiresAt: Date.now() + 60_000, path: '.', includeHidden: false, offset: 0 };
  await f.files.prepare(request, f.signal);
  const result = await f.files.send(request, f.signal, async () => { throw new Error('Listing must not upload chunks'); });
  assert.deepEqual(result.listing!.entries.map(entry => entry.path), ['link', 'visible']);
  assert.ok(result.listing!.entries.length <= LOCAL_LIST_PAGE);
  await f.files.discard(request.id);
  await assert.rejects(f.files.prepare({ ...request, path: 'link' }, f.signal), /Symlink/);
  assert.ok((await lstat(join(f.root, 'link'))).isSymbolicLink());
});
