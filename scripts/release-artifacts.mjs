import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

export async function verifyArtifacts(directory, { sha, version }) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const manifests = [], checksums = [];
  for (const target of targets) {
    const name = `juiced-${target}.tar.gz`;
    const digest = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
    assert.equal((await readFile(join(directory, name + '.sha256'), 'utf8')).trim(), `${digest}  ${name}`, `${target}: checksum mismatch`);
    const { stdout } = await execute('tar', ['-xOf', join(directory, name), 'juiced/release.json'], { maxBuffer: 65536 });
    const manifest = JSON.parse(stdout);
    assert.equal(manifest.commit, sha, `${target}: source commit mismatch`);
    assert.equal(manifest.sourceClean, true, `${target}: archive was built from uncommitted source`);
    assert.equal(manifest.version, version, `${target}: version mismatch`);
    assert.equal(`${manifest.platform}-${manifest.arch}`, target, `${target}: platform mismatch`);
    assert.match(manifest.runtimeId, /^rt_[a-f0-9]{64}$/);
    manifests.push(manifest);
    checksums.push(`${digest}  ${name}\n`);
  }
  assert.equal(new Set(manifests.map(m => m.runtimeId)).size, 1, 'All platforms must compile the same runtime');
  await writeFile(join(directory, 'SHA256SUMS'), checksums.join(''));
  return { commit: sha, version, runtimeId: manifests[0].runtimeId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
  console.log(JSON.stringify(await verifyArtifacts(process.argv[2] ?? 'dist/releases', {
    sha: process.env.GITHUB_SHA ?? (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), version,
  })));
}
