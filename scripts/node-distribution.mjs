import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Cache public bytes only. Always validate against a fresh upstream checksum manifest. */
export async function nodeDistribution(archive, download, cacheDirectory) {
  assert.match(archive, /^node-v\d+\.\d+\.\d+-(darwin|linux)-(arm64|x64)\.tar\.gz$/);
  const sums = await download('SHASUMS256.txt');
  const expected = sums.toString().split('\n').find(line => line.endsWith(`  ${archive}`))?.split(' ')[0];
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Official Node checksum entry missing');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const path = cacheDirectory && join(cacheDirectory, archive);
  if (path) {
    try {
      const cached = await readFile(path);
      if (digest(cached) === expected) return cached;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const bytes = await download(archive);
  assert.equal(digest(bytes), expected, 'Node checksum mismatch');
  if (path) {
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = path + '.' + randomUUID();
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  }
  return bytes;
}
