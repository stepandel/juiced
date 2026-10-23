import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findPrepared, listPreparations, selectPreparation } from './prepared-release.mjs';
import { stageNames, preparationTiming, releaseReport, formatReleaseReport, writeReleaseReport } from './release-report.mjs';
import { targets, verifyArtifacts } from './release-artifacts.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json')));
const privateJSON = async path => {
  const content = await readFile(path, 'utf8');
  try { return JSON.parse(content); }
  catch { throw new Error(`Invalid JSON in private release configuration: ${path}`); }
};
export const releaseSteps = stageNames;

export function assertGeneration(generation, active) {
  assert.ok(Number.isSafeInteger(generation) && generation > 0 &&
    Number.isSafeInteger(active) && active >= 0, 'Invalid release generation');
  assert.ok(active <= generation, 'Release superseded; refusing to resume an older production rollout');
}

/** Only completed stages are checkpointed. An interrupted external operation must be observed on retry. */
export async function checkpoint(state, name, work, save, report = console.log) {
  if (state.completed[name]) { report(`${name}: reused`); return; }
  report(`${name}: starting`);
  const start = Date.now();
  state.attempts ??= [];
  try { await work(); }
  catch (error) {
    state.attempts.push({ name, status: 'failure', completedAt: new Date().toISOString(), durationMs: Date.now() - start });
    await save();
    throw error;
  }
  const timing = { completedAt: new Date().toISOString(), durationMs: Date.now() - start };
  state.attempts.push({ name, status: 'success', ...timing });
  state.completed[name] = timing;
  await save();
  report(`${name}: completed in ${Math.ceil((Date.now() - start) / 1000)}s`);
}

/** Secrets travel over stdin/environment. Failures expose the log path, not captured output. */
export async function privateCommand(name, command, args, options, log) {
  const { input, ...overrides } = options;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = execFile(command, args, { timeout: 20 * 60_000,
        maxBuffer: 16 * 1024 * 1024, ...overrides }, (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout, stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    await writeFile(log, result.stdout + result.stderr, { mode: 0o600 });
    return result.stdout.trim();
  } catch (error) {
    await writeFile(log, (error.stdout ?? '') + (error.stderr ?? '') + `\nExit: ${error.code}\n`, { mode: 0o600 });
    throw new Error(`${name} failed; private diagnostic log: ${log}`);
  }
}

export function hostedIntegration(document, runtimeId) {
  const api = document.profiles?.api?.fleets?.find(f => f.name === 'juiced');
  const worker = document.profiles?.worker?.fleets?.find(f => f.name === 'juiced');
  assert.ok(api && worker && /^flt_[a-f0-9]{32}$/.test(api.id) && api.id === worker.id, 'Matching API/worker Fleet bindings required');
  assert.equal(api.controlUrl, worker.controlUrl, 'API and worker must use the same Fleet control origin');
  assert.ok(api.accessToken && worker.accessToken && api.accessToken !== worker.accessToken, 'Separate API/worker principals required');
  assert.match(api.packageId, /^pkg_[a-f0-9]{32}$/);
  assert.equal(api.runtimeId, runtimeId, 'Deployment must match qualified CLI runtime');
  return { schemaVersion: 1, activeProfile: 'api', profiles: {
    api: { apps: [], fleets: [api] },
    worker: { apps: [], fleets: [{ ...api, accessToken: worker.accessToken, expiresAt: worker.expiresAt }] },
  } };
}

export async function waitFor(check, { timeout = 15 * 60_000, interval = 5000, sleep = delay } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(interval);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for release readiness');
}

export async function release(mode, options = {}, env = process.env) {
  if (!['plan', 'prepare', 'ship', 'report'].includes(mode)) throw new Error('Usage: npm run release -- plan|prepare|ship|report [--state DIR] [--resume-package pkg_...] [--json]');
  if (mode === 'report' && options.state) {
    const report = releaseReport(await privateJSON(join(resolve(options.state), 'state.json')));
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReleaseReport(report));
    return;
  }
  const sha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const version = manifest.version, tag = `v${version}`;
  if (mode === 'plan') {
    console.log(JSON.stringify({ commit: sha, version, prepare: releaseSteps.slice(0, 2), ship: releaseSteps.slice(2),
      note: 'Preparation builds locally and may request protected CI. Ship publishes and changes production.' }, null, 2));
    return;
  }
  const directory = resolve(options.state ?? join(root, 'dist/release', `${version}-${sha.slice(0, 12)}`));
  if (mode === 'report') {
    const report = releaseReport(await privateJSON(join(directory, 'state.json')));
    console.log(options.json ? JSON.stringify(report, null, 2) : formatReleaseReport(report));
    return;
  }
  const inside = relative(root, directory);
  assert.ok(inside === '..' || inside.startsWith('../') || inside.startsWith('dist/release/'),
    'Keep private release state outside the source checkout or under dist/release/');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = join(directory, 'lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Release already locked: ${lockPath}. Remove only after confirming its process has stopped.`);
  });
  await lock.writeFile(String(process.pid));
  let state, invocation, save, succeeded = false;
  try {
    const statePath = join(directory, 'state.json');
    try { state = JSON.parse(await readFile(statePath)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The generation is assigned on first ship, so promotion order follows shipping, not preparation.
    state ??= { schemaVersion: 1, commit: sha, version, completed: {} };
    assert.equal(state.commit, sha, 'Resume from the original source commit');
    assert.equal(state.version, version);
    let saving = Promise.resolve();
    invocation = { mode, startedAt: new Date().toISOString() };
    (state.invocations ??= []).push(invocation);
    save = () => {
      const snapshot = JSON.stringify(state, null, 2);
      saving = saving.then(async () => {
        await writeFile(statePath + '.tmp', snapshot, { mode: 0o600 });
        await rename(statePath + '.tmp', statePath);
      });
      return saving;
    };
    await save();
    const repository = env.JUICED_RELEASE_REPOSITORY ?? 'stepandel/juiced';
    const scope = env.VERCEL_SCOPE ?? 'stepandels-projects';
    const project = env.VERCEL_PROJECT ?? 'juiced';
    const origin = new URL(env.JUICED_SERVICE_URL ?? 'https://juiced.codes');
    assert.ok(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/', 'Expected an HTTPS service origin');
    const cantelop = env.CANTELOP_BIN ?? 'cantelop';
    const integration = join(directory, 'integration.json');
    const hosted = join(directory, 'integration-host.json');
    const artifacts = join(directory, 'artifacts');
    await mkdir(artifacts, { recursive: true });
    const run = (name, command, args, extra = {}) => privateCommand(name, command, args,
      { cwd: root, env, ...extra }, join(directory, `${name}.log`));
    const step = (name, work) => checkpoint(state, name, work, save);
    // Always repeat preflight, including on resume. No production changes before these pass.
    assert.equal(await run('git-clean', 'git', ['status', '--porcelain', '--untracked-files=normal']), '', 'Commit source changes before releasing');
    await run('fetch', 'git', ['fetch', 'origin', 'main', '--tags']);
    await run('main-source', 'git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
    const remoteTag = await run('tag-source', 'git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    if (remoteTag) assert.equal(remoteTag.trim().split('\n').at(-1).split(/\s/)[0], sha, 'A published version cannot be reused for different source');
    const toolVersion = await run('cantelop-version', cantelop, ['--version']);
    const match = toolVersion.match(/(\d+)\.(\d+)\.(\d+)/);
    assert.ok(match && (Number(match[1]) > 0 || Number(match[2]) > 17 || (Number(match[2]) === 17 && Number(match[3]) >= 1)), 'Fleet releases require Cantelop CLI >=0.17.1');
    await run('github-auth', 'gh', ['auth', 'status']);
    await run('vercel-auth', 'vercel', ['whoami', '--scope', scope]);
    await run('vercel-project', 'vercel', ['link', '--yes', '--project', project, '--scope', scope]);
    assert.ok(env.CANTELOP_FLEET_TOKEN, 'Supply a short-lived Fleet deployment principal');
    try { await stat(integration); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.ok(env.CANTELOP_INTEGRATION_CONFIG, 'Supply the private API/worker integration file');
      const source = resolve(env.CANTELOP_INTEGRATION_CONFIG);
      assert.equal((await stat(source)).mode & 0o077, 0, 'Private integration file must have mode 600');
      await copyFile(source, integration);
      await chmod(integration, 0o600);
    }
    const document = await privateJSON(integration);
    const binding = document.profiles?.api?.fleets?.find(f => f.name === 'juiced');
    const worker = document.profiles?.worker?.fleets?.find(f => f.name === 'juiced');
    assert.ok(binding && worker && binding.id === worker.id && binding.accessToken !== worker.accessToken, 'Private integration must contain separate API/worker profiles for the same Fleet');
    for (const entry of [binding, worker]) {
      assert.match(entry.id, /^flt_[a-f0-9]{32}$/);
      assert.ok(/^fsp_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(entry.accessToken), 'Invalid service principal format');
      assert.ok(Date.parse(entry.expiresAt) > Date.now(), 'Service principal has expired');
    }
    const fleetEnv = { ...env, CANTELOP_INTEGRATION_CONFIG: integration, CANTELOP_FLEET_SERVICE_TOKEN: binding.accessToken };
    delete fleetEnv.CANTELOP_APP_CONFIG;
    const deployArgs = ['deploy', '--app', 'juiced', '--fleet', binding.id, '--package-version', version, '--fleet-profile', 'api'];
    const api = async (path, body) => JSON.parse((await run('github-api', 'gh', ['api', path, ...(body ? ['--method', 'POST', '--input', '-'] : [])], body ? { input: JSON.stringify(body) } : {})) || '{}');
    const preparation = await Promise.allSettled([
      step('cli-artifacts', async () => {
        const selection = await selectPreparation(sha, repository, api);
        const id = selection.runId ?? await waitFor(async () => {
          const runs = await listPreparations(sha, repository, api);
          const found = await findPrepared(sha, repository, api, runs);
          if (found) return found;
          const selected = runs.filter(r => selection.pendingRunIds.includes(r.id));
          if (selected.length && selected.every(r => r.status === 'completed'))
            throw new Error('Selected release preparation failed. Inspect the Release Juiced CLI workflow before retrying.');
          console.log('Waiting for protected native CLI qualification…');
        }, { interval: 15_000 });
        try {
          const [runInfo, { jobs }] = await Promise.all([
            api(`repos/${repository}/actions/runs/${id}`),
            api(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`),
          ]);
          state.ciTiming = preparationTiming(runInfo, jobs);
        } catch { console.log('CI timing data unavailable; qualification still verified.'); }
        for (const target of targets) for (const suffix of ['.tar.gz', '.tar.gz.sha256'])
          await rm(join(artifacts, `juiced-${target}${suffix}`), { force: true });
        await Promise.all(targets.map(target => run(`download-${target}`, 'gh', ['run', 'download', id, '--repo', repository, '--name', `juiced-${target}`, '--dir', artifacts])));
        state.artifactsRunId = id;
        state.runtimeId = (await verifyArtifacts(artifacts, { sha, version })).runtimeId;
      }),
      step('runtime-preflight', async () => { await run('runtime-preflight', cantelop, [...deployArgs, '--dry-run'], { env: fleetEnv }); }),
    ]);
    const failures = preparation.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Release preparation failed');
    await run('build-smoke-cli', 'npm', ['run', 'build']);
    await run('build-runtime-identity', 'npm', ['run', 'build:runtime']);
    // Recheck even reused stages, so edited/stale artifacts cannot be promoted.
    const qualified = await verifyArtifacts(artifacts, { sha, version });
    const compiled = JSON.parse(await readFile(join(root, 'dist/cantelop/backend/cantelop-client.json'))).apps.find(a => a.name === 'juiced');
    assert.equal(compiled.session_runtime_id, qualified.runtimeId, 'Local runtime differs from qualified archives');
    if (mode === 'prepare') { succeeded = true; return; }
    await run('account-preflight', process.execPath, ['bin/juiced.mjs', 'whoami'], { env: { ...env, JUICED_SERVICE_URL: origin.origin, JUICED_TELEMETRY_DISABLED: '1' } });
    await waitFor(async () => {
      const { workflow_runs: runs } = await api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=20`);
      if (runs.some(r => r.conclusion === 'success')) return true;
      if (!runs.length || runs.every(r => r.status === 'completed')) throw new Error('Main service CI must pass before publication');
      console.log('Waiting for main service CI…');
    }, { interval: 15_000 });
    if (!state.generation) { state.generation = Date.now(); await save(); }
    const checkActive = async () => {
      const result = await fetch(new URL('/api/release', origin), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      assert.equal(result.status, 200, 'Deploy the release control endpoint before using ship');
      assertGeneration(state.generation, (await result.json()).generation);
    };
    await checkActive();
    await step('publish-cli', async () => {
      if (!remoteTag) {
        const local = await run('local-tags', 'git', ['tag', '--list', tag]);
        if (!local) await run('create-tag', 'git', ['tag', '-a', tag, sha, '-m', `Juiced ${version}`]);
        assert.equal(await run('verify-tag', 'git', ['rev-parse', `${tag}^{commit}`]), sha);
        await run('push-tag', 'git', ['push', 'origin', `refs/tags/${tag}`]);
      }
      await waitFor(async () => {
        let result;
        try {
          result = JSON.parse(await run('release-ready', 'gh', ['release', 'view', tag, '--repo', repository, '--json', 'assets,isDraft']));
        } catch { /* The tag workflow may not have created its draft yet. */ }
        if (result) {
          const names = new Set(result.assets.map(a => a.name));
          if ([...targets.map(t => `juiced-${t}.tar.gz`), 'SHA256SUMS', 'install.sh'].every(n => names.has(n))) return true;
        }
        const { workflow_runs: runs } = await api(`repos/${repository}/actions/workflows/release.yml/runs?head_sha=${sha}&event=push&per_page=100`);
        if (runs.some(r => r.head_branch === tag && r.status === 'completed' && r.conclusion !== 'success'))
          throw new Error('Tag release workflow failed; inspect its logs before retrying');
        return false;
      });
      await run('publish-cli', 'gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', version.includes('-') ? '--latest=false' : '--latest']);
    });
    // CLI deployment currently publishes AND rolls live instances. Public CLI assets must exist first.
    await checkActive();
    await step('deploy-runtime', async () => {
      const resume = options['resume-package'];
      if (resume) assert.match(resume, /^pkg_[a-f0-9]{32}$/);
      await run('deploy-runtime', cantelop, [...deployArgs, ...(resume ? ['--resume-package', resume] : [])], { env: fleetEnv });
      const deployed = await privateJSON(integration);
      const updated = hostedIntegration(deployed, qualified.runtimeId);
      await writeFile(hosted, JSON.stringify(updated), { mode: 0o600 });
      state.packageId = updated.profiles.api.fleets[0].packageId;
      await save();
    });
    const hostDocument = hostedIntegration(await privateJSON(hosted), qualified.runtimeId);
    const hostedBinding = hostDocument.profiles.api.fleets[0];
    assert.equal(hostedBinding.packageId, state.packageId);
    const control = new URL(hostedBinding.controlUrl);
    assert.ok(control.protocol === 'https:' && !control.username && !control.password, 'Expected an HTTPS Fleet control origin');
    const pkgResponse = await fetch(new URL(`/v1/fleets/${binding.id}/packages/${state.packageId}`, control), {
      headers: { Authorization: `Bearer ${env.CANTELOP_FLEET_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    assert.ok(pkgResponse.ok, 'Cannot verify published Fleet package');
    const pkg = await pkgResponse.json();
    assert.ok(pkg.version === version && pkg.runtime_id === qualified.runtimeId && pkg.execution === 'ready' && !pkg.disabled_at, 'Fleet package must be ready and match the release');
    await step('qualify-runtime', async () => {
      await run('qualify-runtime', process.execPath, ['--import', 'tsx', 'scripts/release-canary.mjs', hosted, String(state.generation), directory]);
    });
    let token;
    const tokenPath = join(directory, 'promotion-token');
    try { token = await readFile(tokenPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.ok(!state.completed['deploy-service'], 'The original promotion token is required to resume');
      token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { mode: 0o600 });
    }
    await checkActive();
    await step('deploy-service', async () => {
      const values = { CANTELOP_APP_CONFIG: JSON.stringify(hostDocument), CANTELOP_API_PROFILE: 'api', CANTELOP_WORKER_PROFILE: 'worker',
        JUICED_CLI_VERSION: version, JUICED_MINIMUM_CLI: version, JUICED_RELEASE_GENERATION: String(state.generation), JUICED_RELEASE_TOKEN: token };
      for (const [name, value] of Object.entries(values)) await run(`env-${name}`, 'vercel', ['env', 'add', name, 'production', '--sensitive', '--force', '--yes', '--project', project, '--scope', scope], { input: value });
      await run('deploy-service', 'vercel', ['deploy', '--prod', '--yes', '--scope', scope]);
    });
    await checkActive();
    await step('resume-rollout', async () => {
      await run('resume-rollout', cantelop, [...deployArgs, '--resume-package', state.packageId], { env: fleetEnv });
    });
    await checkActive();
    await step('promote', async () => {
      const result = await fetch(new URL('/api/release', origin), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(120_000) });
      assert.equal(result.status, 202, 'Promotion failed; retry to recover a committed intent or failed wake-up');
      const receipt = await result.json();
      assert.equal(receipt.generation, state.generation);
      assert.equal(receipt.packageId, state.packageId);
      assert.equal(receipt.runtimeId, qualified.runtimeId);
    });
    await step('verify-live', async () => {
      for (const path of ['/health', '/ready', '/v1/config']) {
        const result = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(20_000), redirect: 'error' });
        assert.ok(result.ok, `${path} is unhealthy`);
        if (path === '/v1/config') assert.equal((await result.json()).cliVersion, version);
      }
      const install = join(directory, 'install'), bin = join(directory, 'bin');
      const smokeEnv = { ...env, JUICED_INSTALL_DIR: install, JUICED_BIN_DIR: bin, JUICED_SERVICE_URL: origin.origin, JUICED_TELEMETRY_DISABLED: '1' };
      // Run the installer users actually fetch, not the checkout's copy.
      const served = await fetch(new URL('/install.sh', origin), { signal: AbortSignal.timeout(20_000), redirect: 'error' });
      assert.ok(served.ok, '/install.sh is unavailable');
      const installer = join(directory, 'install.sh');
      await writeFile(installer, await served.text(), { mode: 0o600 });
      await run('public-install', '/bin/sh', [installer, version], { env: smokeEnv });
      const cli = join(bin, 'juiced'), prefix = ['--workspace', `release-${state.generation}`];
      let failure;
      try {
        const output = await run('managed-smoke', cli, [...prefix, 'claude', '--version'], { cwd: directory, env: smokeEnv, timeout: 360_000 });
        assert.match(output, /\d+\.\d+\.\d+.*Claude Code/i);
      } catch (error) { failure = error; }
      try { await run('managed-cleanup', cli, [...prefix, 'claude', 'delete', '--yes'], { cwd: directory, env: smokeEnv, timeout: 360_000 }); }
      catch (error) { throw new AggregateError([failure, error].filter(Boolean), 'Release smoke/cleanup failed; resume after checking private logs'); }
      if (failure) throw failure;
    });
    succeeded = true;
    console.log(`Shipped ${tag}; receipt and stage timings: ${statePath}`);
  } finally {
    try {
      if (save) {
        Object.assign(invocation, { status: succeeded ? 'success' : 'failure', completedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(invocation.startedAt) });
        await save();
        console.log(formatReleaseReport(await writeReleaseReport(directory, state)));
      }
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = 'plan', ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && mode === 'report') { options.json = true; continue; }
    if (!['--state', '--resume-package'].includes(args[i]) || !args[i + 1]) throw new Error('Unknown or missing release option');
    options[args[i].slice(2)] = args[++i];
  }
  await release(mode, options);
}
