import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkpoint, hostedIntegration, privateCommand, assertGeneration } from './release.mjs';
import { findPrepared, preparedRuns, completeArtifacts, selectPreparation, releaseSource, reuseBackground } from './prepared-release.mjs';
import { preparationTiming, releaseReport, formatReleaseReport, writeReleaseReport } from './release-report.mjs';
import { targets, verifyArtifacts } from './release-artifacts.mjs';
import { canaryPolicy, qualifyInstance } from './release-canary.mjs';
import { nodeDistribution } from './node-distribution.mjs';
const execute = promisify(execFile);
const sha = 'a'.repeat(40), runtimeId = 'rt_' + 'b'.repeat(64), repository = 'stepandel/juiced';

test('an obsolete receipt cannot resume rollout after a newer release or rollback', () => {
  assertGeneration(2, 0);
  assertGeneration(2, 2);
  assert.throws(() => assertGeneration(2, 3), /superseded/);
  for (const active of [-1, NaN, '2', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => assertGeneration(2, active), /Invalid/);
});

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
  assert.deepEqual(calls, ['save', 'deploy', 'save']);
  assert.deepEqual(state.attempts.map(a => a.status), ['failure', 'success']);
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


test('release selection protects exact main commits instead of waiting on cancellable background builds', async () => {
  const background = { id: 1, head_sha: sha, event: 'push', head_branch: 'main', status: 'in_progress', head_repository: { full_name: repository }, path: '.github/workflows/release.yml' };
  const selected = { ...background, id: 2, event: 'workflow_dispatch', head_sha: 'c'.repeat(40), display_title: `Prepare ${sha}` };
  let runs = [background], artifacts = [], dispatches = [];
  const api = async (path, body) => {
    if (body) { dispatches.push({ path, body }); return { workflow_run_id: 3 }; }
    return path.includes('/artifacts?') ? { artifacts } : { workflow_runs: runs };
  };
  assert.deepEqual(await selectPreparation(sha, repository, api), { pendingRunIds: [3] });
  assert.deepEqual(dispatches, [{ path: `repos/${repository}/actions/workflows/release.yml/dispatches`, body: { ref: 'main', inputs: { commit: sha }, return_run_details: true } }]);
  runs = [background, selected];
  assert.deepEqual(await selectPreparation(sha, repository, api), { pendingRunIds: [2] });
  assert.equal(dispatches.length, 1);
  runs = [{ ...selected, status: 'completed', conclusion: 'success' }];
  artifacts = ['release-qualified', ...targets.map(t => `juiced-${t}`)].map(name => ({ name }));
  assert.deepEqual(await selectPreparation(sha, repository, api), { runId: '2' });
  for (const override of [{ head_branch: 'feature' }, { display_title: `Prepare ${'d'.repeat(40)}` }, { path: '.github/workflows/untrusted.yml' }, { head_repository: { full_name: 'fork/juiced' } }])
    assert.deepEqual(preparedRuns([{ ...runs[0], ...override }], sha, repository), []);
  artifacts[0].expired = true;
  assert.deepEqual(await selectPreparation(sha, repository, api), { pendingRunIds: [3] });
  assert.equal(dispatches.length, 2);
});

test('selected source must be an immutable ancestor of main and dispatch must use the main workflow', async () => {
  const calls = [], git = async args => { calls.push(args); };
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'c'.repeat(40), SELECTED_COMMIT: sha };
  assert.equal(await releaseSource(env, git), sha);
  assert.deepEqual(calls, [['merge-base', '--is-ancestor', sha, 'origin/main']]);
  await assert.rejects(releaseSource({ ...env, GITHUB_REF: 'refs/heads/feature' }, git), /main workflow/);
  await assert.rejects(releaseSource({ ...env, SELECTED_COMMIT: 'main' }, git), /exact source/);
  await assert.rejects(releaseSource(env, async () => { throw new Error('not on main'); }), /not on main/);
  assert.equal(await releaseSource({ ...env, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha }, git), sha);
});

test('timing reports measure scheduling after dependencies and export only known fields', async t => {
  const at = seconds => new Date(seconds * 1000).toISOString();
  const ci = preparationTiming({ created_at: at(0), accessToken: 'secret' }, [
    { name: 'prepared', conclusion: 'success', started_at: at(2), completed_at: at(5) },
    { name: 'package (macos-14, darwin-arm64)', conclusion: 'success', started_at: at(25), completed_at: at(60), account: 'private' },
    { name: 'qualified', conclusion: 'success', started_at: at(65), completed_at: at(70) },
    { name: 'secret-job', conclusion: 'success', started_at: at(0), completed_at: at(99999) },
  ]);
  assert.equal(ci.durationMs, 70000);
  assert.deepEqual(ci.jobs.map(j => j.schedulingDelayMs), [2000, 20000, 5000]);
  const rerun = preparationTiming({ created_at: at(0), run_attempt: 2 }, [
    { name: 'prepared', conclusion: 'success', started_at: at(86400), completed_at: at(86405) },
  ]);
  assert.equal(rerun.durationMs, null);
  assert.deepEqual(rerun.jobs[0], { name: 'prepared', schedulingDelayMs: null, durationMs: 5000 });
  const state = { commit: sha, version: '1.0.0-rc.1', ciTiming: { ...ci, token: 'secret' },
    account: 'secret', integration: { accessToken: 'secret' },
    completed: { 'cli-artifacts': { completedAt: at(10), durationMs: 10000 }, 'runtime-preflight': { completedAt: at(15), durationMs: 10000 } },
    attempts: [{ name: 'deploy-runtime', status: 'failure', completedAt: at(25), durationMs: 5000, error: 'secret' }],
    invocations: [{ mode: 'prepare', status: 'success', completedAt: at(30), durationMs: 30000, stdout: 'secret' },
      { mode: 'ship', status: 'failure', completedAt: at(150), durationMs: 20000 }],
  };
  const report = releaseReport(state);
  assert.equal(report.recordedActiveMs, 20000); // 0..15 plus 20..25, rather than summing parallel work.
  assert.equal(report.operatorActiveMs, 50000); // Excludes the pause between commands.
  assert.equal(report.status, 'prepared');
  assert.equal(report.stages.find(s => s.name === 'deploy-runtime').failedAttempts, 1);
  const rendered = JSON.stringify(report) + formatReleaseReport(report);
  assert.doesNotMatch(rendered, /secret|accessToken|account|integration|stdout/);
  assert.match(rendered, /Scheduling delay/);
  assert.throws(() => releaseReport({ ...state, version: 'secret-invalid-version' }), error => !error.message.includes('secret'));
  const dir = await mkdtemp(join(tmpdir(), 'juiced-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeReleaseReport(dir, state);
  for (const file of ['summary.json', 'summary.md']) {
    assert.doesNotMatch(await readFile(join(dir, file), 'utf8'), /secret/);
    assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const { stdout } = await execute(process.execPath, ['scripts/release.mjs', 'report', '--state', dir, '--json'],
    { env: { PATH: '/no-tools', HOME: dir } });
  assert.deepEqual(JSON.parse(stdout), report); // No gh, Git, deployment token or login needed.
});

test('old receipts report unavailable timing without inventing durations or exposing unknown entries', () => {
  const report = releaseReport({ commit: sha, version: '1.0.0', completed: { 'verify-live': { completedAt: 'invalid', durationMs: -1 }, secret: { durationMs: 1000 } }, ciTiming: { durationMs: 'secret', jobs: [{ name: 'secret', durationMs: 1000 }] } });
  assert.equal(report.operatorActiveMs, null);
  assert.equal(report.recordedActiveMs, 0);
  assert.deepEqual(report.preparation, { durationMs: null, jobs: [] });
  assert.equal(report.stages.find(s => s.name === 'verify-live').durationMs, null);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});


test('protected preparation reuses in-flight background work and builds if main cancels it', async () => {
  const run = { id: 1, head_sha: sha, event: 'push', head_branch: 'main', status: 'in_progress', head_repository: { full_name: repository }, path: '.github/workflows/release.yml' };
  const artifacts = ['release-qualified', ...targets.map(t => `juiced-${t}`)].map(name => ({ name }));
  const api = async path => path.includes('/artifacts?') ? { artifacts } : { workflow_runs: [run] };
  let sleeps = 0;
  assert.equal(await reuseBackground(sha, repository, api, async () => {
    sleeps++; run.status = 'completed'; run.conclusion = 'success';
  }), '1');
  assert.equal(sleeps, 1);
  run.conclusion = 'cancelled';
  assert.equal(await reuseBackground(sha, repository, api, async () => { throw new Error('must not wait'); }), '');
  run.conclusion = 'failure';
  assert.equal(await reuseBackground(sha, repository, api), ''); // Failed builds never qualify a release; run fresh tests.
});
