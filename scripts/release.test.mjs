import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkpoint, hostedIntegration, privateCommand } from './release.mjs';
import { findPrepared, preparedRuns, completeArtifacts } from './prepared-release.mjs';
import { targets, verifyArtifacts } from './release-artifacts.mjs';
import { canaryPolicy, qualifyInstance } from './release-canary.mjs';
import { nodeDistribution } from './node-distribution.mjs';
const execute = promisify(execFile);
const sha = 'a'.repeat(40), runtimeId = 'rt_' + 'b'.repeat(64), repository = 'stepandel/juiced';

test('cached Node distributions are checked against fresh official sums and corrupt caches are replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'juiced-node-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = 'node-v24.20.0-darwin-x64.tar.gz', bytes = Buffer.from('official portable runtime');
  const digest = createHash('sha256').update(bytes).digest('hex'), requests = [];
  const download = async name => {
    requests.push(name);
    return name === archive ? bytes : Buffer.from(`${digest}  ${archive}\n`);
  };
  await nodeDistribution(archive, download, dir);
  assert.deepEqual(requests, ['SHASUMS256.txt', archive]);
  requests.length = 0;
  await nodeDistribution(archive, download, dir);
  assert.deepEqual(requests, ['SHASUMS256.txt']);
  await writeFile(join(dir, archive), 'corrupt cached bytes');
  requests.length = 0;
  assert.deepEqual(await nodeDistribution(archive, download, dir), bytes);
  assert.deepEqual(requests, ['SHASUMS256.txt', archive]);
  await assert.rejects(nodeDistribution(archive,
    async name => name === archive ? Buffer.from('tampered') : Buffer.from(`${digest}  ${archive}\n`)), /checksum mismatch/);
});

test('artifact reuse requires successful main qualification of the exact commit in this repository', async () => {
  const valid = { id: 1, head_sha: sha, event: 'push', head_branch: 'main', conclusion: 'success', head_repository: { full_name: repository }, path: '.github/workflows/release.yml' };
  for (const override of [{ head_sha: 'c'.repeat(40) }, { event: 'pull_request' }, { conclusion: 'failure' }, { head_branch: 'other' }, { head_repository: { full_name: 'fork/juiced' } }, { path: '.github/workflows/other.yml' }]) {
    assert.deepEqual(preparedRuns([{ ...valid, ...override }], sha, repository), []);
  }
  const artifacts = ['release-qualified', ...targets.map(t => `juiced-${t}`)].map(name => ({ name, expired: false }));
  assert.equal(completeArtifacts(artifacts), true);
  assert.equal(completeArtifacts(artifacts.map((a, i) => ({ ...a, expired: i === 0 }))), false);
  assert.equal(completeArtifacts(artifacts.slice(1)), false);
  const result = await findPrepared(sha, repository, async path => path.includes('/artifacts?') ? { artifacts } : { workflow_runs: [valid] });
  assert.equal(result, '1');
});

test('qualified archives must agree on source, platform, checksum and runtime', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'juiced-artifacts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'juiced'));
  const make = async (target, overrides = {}) => {
    const [platform, arch] = target.split('-');
    await writeFile(join(dir, 'juiced/release.json'), JSON.stringify({ commit: sha, sourceClean: true, version: '1.0.0', platform, arch, runtimeId, ...overrides }));
    const name = `juiced-${target}.tar.gz`;
    await execute('tar', ['-czf', join(dir, name), '-C', dir, 'juiced']);
    const digest = createHash('sha256').update(await readFile(join(dir, name))).digest('hex');
    await writeFile(join(dir, name + '.sha256'), `${digest}  ${name}\n`);
  };
  for (const target of targets) await make(target);
  assert.deepEqual(await verifyArtifacts(dir, { sha, version: '1.0.0' }), { commit: sha, version: '1.0.0', runtimeId });
  await make(targets[0], { commit: 'd'.repeat(40) });
  await assert.rejects(verifyArtifacts(dir, { sha, version: '1.0.0' }), /source commit mismatch/);
  await make(targets[0], { sourceClean: false });
  await assert.rejects(verifyArtifacts(dir, { sha, version: '1.0.0' }), /uncommitted source/);
  await make(targets[0], { runtimeId: 'rt_' + 'c'.repeat(64) });
  await assert.rejects(verifyArtifacts(dir, { sha, version: '1.0.0' }), /same runtime/);
  await make(targets[0]);
  await writeFile(join(dir, `juiced-${targets[0]}.tar.gz.sha256`), 'corrupt');
  await assert.rejects(verifyArtifacts(dir, { sha, version: '1.0.0' }), /checksum mismatch/);
});

test('resume skips completed stages and retries failures without checkpointing them', async () => {
  const state = { completed: {} }, calls = [];
  const save = async () => { calls.push('save'); };
  await assert.rejects(checkpoint(state, 'deploy', async () => { throw new Error('interrupted'); }, save, () => {}), /interrupted/);
  assert.deepEqual(state.completed, {});
  await checkpoint(state, 'deploy', async () => { calls.push('deploy'); }, save, () => {});
  await checkpoint(state, 'deploy', async () => { throw new Error('must not repeat mutation'); }, save, () => {});
  assert.deepEqual(calls, ['deploy', 'save']);
});

test('operator commands receive stdin secrets and keep failure output in private logs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'juiced-private-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'command.log'), secret = 'secret-on-stdin';
  const echo = 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(s))';
  assert.equal(await privateCommand('echo', process.execPath, ['-e', echo], { input: secret }, log), secret);
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  await assert.rejects(privateCommand('failure', process.execPath,
    ['-e', 'console.error("secret-in-error");process.exit(1)'], {}, log), error => {
    assert.doesNotMatch(error.message, /secret-in-error/);
    assert.match(error.message, /private diagnostic log/);
    return true;
  });
  assert.match(await readFile(log, 'utf8'), /secret-in-error/);
});

test('host promotion preserves worker authority while updating its package binding', () => {
  const api = { name: 'juiced', id: 'flt_' + 'a'.repeat(32), packageId: 'pkg_' + 'b'.repeat(32), runtimeId, accessToken: 'api' };
  const worker = { ...api, packageId: 'old', runtimeId: 'old', accessToken: 'worker', expiresAt: 'future' };
  const doc = { profiles: { api: { fleets: [api] }, worker: { fleets: [worker] } } };
  const result = hostedIntegration(doc, runtimeId);
  assert.equal(result.profiles.worker.fleets[0].packageId, api.packageId);
  assert.equal(result.profiles.worker.fleets[0].accessToken, 'worker');
  assert.throws(() => hostedIntegration(doc, 'different'), /match qualified CLI runtime/);
  assert.throws(() => hostedIntegration({ profiles: { api: { fleets: [api] }, worker: { fleets: [api] } } }, runtimeId), /Separate/);
});

test('canary uses production capacity and cleans up even when create commits ambiguously', async () => {
  let deleted = 0, policy;
  const expected = { packageId: 'pkg_new', runtimeId };
  const instance = {
    async create() { return { state: 'ready', enforcedRevision: 1, policyRevision: 1, ...expected }; },
    async setPolicy(input) { policy = input.policy; return { revision: 1 }; },
    async app() { return { workspace() { return { session() { return {}; } }; } }; },
    async delete() { deleted++; },
  };
  await qualifyInstance(instance, expected, async (session, args, io) => { io.stdout.write('2.1.305 (Claude Code)'); return 0; }, AbortSignal.timeout(1000));
  for (const [key, value] of Object.entries(canaryPolicy)) assert.equal(policy[key], value);
  assert.equal(deleted, 1);
  instance.create = async () => { throw new Error('lost create response'); };
  await assert.rejects(qualifyInstance(instance, expected, async () => {}, AbortSignal.timeout(1000)), /lost create response/);
  assert.equal(deleted, 2);
});
