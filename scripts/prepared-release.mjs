import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { targets } from './release-artifacts.mjs';

const execute = promisify(execFile);
const defaultAPI = async path => JSON.parse((await execute('gh', ['api', path], { maxBuffer: 2 ** 20 })).stdout);
const validSource = (sha, repository) => {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
};
export function preparationRuns(runs, sha, repository) {
  return runs.filter(run => run.head_branch === 'main' &&
    run.head_repository?.full_name === repository && run.path === '.github/workflows/release.yml' &&
    ((run.event === 'push' && run.head_sha === sha) ||
      (run.event === 'workflow_dispatch' && run.display_title === `Prepare ${sha}`)));
}
export function preparedRuns(runs, sha, repository) {
  return preparationRuns(runs, sha, repository).filter(run => run.conclusion === 'success');
}
export function completeArtifacts(artifacts) {
  const names = new Set(artifacts.filter(a => !a.expired).map(a => a.name));
  return ['release-qualified', ...targets.map(t => `juiced-${t}`)].every(name => names.has(name));
}
// Dispatched runs carry main's tip as head_sha, so bound them by the selected
// commit's date instead and page through every run since then.
async function dispatchRuns(base, sha, repository, api) {
  const { commit } = await api(`repos/${repository}/commits/${sha}`);
  const since = encodeURIComponent(`>=${commit.committer.date}`), runs = [];
  for (let page = 1; ; page++) {
    const { workflow_runs } = await api(`${base}?event=workflow_dispatch&branch=main&created=${since}&per_page=100&page=${page}`);
    runs.push(...workflow_runs);
    if (workflow_runs.length < 100) return runs;
  }
}
export async function listPreparations(sha, repository, api = defaultAPI) {
  validSource(sha, repository);
  const base = `repos/${repository}/actions/workflows/release.yml/runs`;
  const [push, dispatched] = await Promise.all([
    api(`${base}?head_sha=${sha}&event=push&branch=main&per_page=100`),
    dispatchRuns(base, sha, repository, api),
  ]);
  const runs = [...new Map([...push.workflow_runs, ...dispatched].map(r => [r.id, r])).values()];
  return preparationRuns(runs, sha, repository);
}
export async function findPrepared(sha, repository, api = defaultAPI, runs) {
  validSource(sha, repository);
  for (const run of preparedRuns(runs ?? await listPreparations(sha, repository, api), sha, repository)) {
    const { artifacts } = await api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    if (completeArtifacts(artifacts)) return String(run.id);
  }
  return '';
}

// Selection never depends on a cancellable background run. Dispatch stays on the trusted main workflow.
export async function selectPreparation(sha, repository, api) {
  validSource(sha, repository);
  const runs = await listPreparations(sha, repository, api);
  const runId = await findPrepared(sha, repository, api, runs);
  if (runId) return { runId };
  const active = runs.filter(r => r.event === 'workflow_dispatch' && r.status !== 'completed');
  if (active.length) return { pendingRunIds: active.map(r => r.id) };
  const { workflow_run_id: id } = await api(`repos/${repository}/actions/workflows/release.yml/dispatches`,
    { ref: 'main', inputs: { commit: sha }, return_run_details: true });
  assert.ok(Number.isSafeInteger(id) && id > 0, 'GitHub did not return the selected preparation run');
  return { pendingRunIds: [id] };
}

// A selected run can wait on the same commit's existing background work without
// taking more Mac slots. If main advances and cancels it, or it stays pending past
// the bounded wait, this run builds instead.
export async function reuseBackground(sha, repository, api = defaultAPI, sleep = delay) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const runs = await listPreparations(sha, repository, api);
    const found = await findPrepared(sha, repository, api, runs);
    if (found) return found;
    const background = runs.filter(r => r.event === 'push');
    if (!background.some(r => r.status !== 'completed')) return '';
    await sleep(15000);
  }
  console.log('Background qualification is still pending; building the selected commit instead');
  return '';
}

export async function releaseSource(env, git = async args => (await execute('git', args)).stdout.trim()) {
  const selected = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (selected) assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Select releases through the main workflow');
  const sha = selected ? env.SELECTED_COMMIT : env.GITHUB_SHA;
  assert.match(sha, /^[a-f0-9]{40}$/, 'An exact source commit is required');
  // Tags publish whatever commit they name, as before; only main sources need ancestry.
  if (env.GITHUB_REF_TYPE === 'tag') return sha;
  await git(['merge-base', '--is-ancestor', sha, 'origin/main']).catch(() => {
    throw new Error(`Release source ${sha} is not on main`);
  });
  return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = await releaseSource(process.env);
  const runId = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? await reuseBackground(sha, process.env.GITHUB_REPOSITORY)
    : process.env.GITHUB_REF_TYPE === 'tag' ? await findPrepared(sha, process.env.GITHUB_REPOSITORY) : '';
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${runId}\nsource_sha=${sha}\n`);
  console.log(runId ? `Reuse qualified artifacts from run ${runId}` : `Build and qualify ${sha}`);
}
