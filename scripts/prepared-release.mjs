import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { targets } from './release-artifacts.mjs';

const execute = promisify(execFile);
export function preparedRuns(runs, sha, repository) {
  return runs.filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === 'main' &&
    run.conclusion === 'success' && run.head_repository?.full_name === repository &&
    run.path === '.github/workflows/release.yml');
}
export function completeArtifacts(artifacts) {
  const names = new Set(artifacts.filter(a => !a.expired).map(a => a.name));
  return ['release-qualified', ...targets.map(t => `juiced-${t}`)].every(name => names.has(name));
}
export async function findPrepared(sha, repository, api = async path =>
  JSON.parse((await execute('gh', ['api', path], { maxBuffer: 2 ** 20 })).stdout)) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid release source');
  const { workflow_runs } = await api(`repos/${repository}/actions/workflows/release.yml/runs?head_sha=${sha}&event=push&branch=main&status=success&per_page=100`);
  for (const run of preparedRuns(workflow_runs, sha, repository)) {
    const { artifacts } = await api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    if (completeArtifacts(artifacts)) return String(run.id);
  }
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = process.env.GITHUB_REF_TYPE === 'tag'
    ? await findPrepared(process.env.GITHUB_SHA, process.env.GITHUB_REPOSITORY) : '';
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`);
  console.log(runId ? `Reuse qualified artifacts from run ${runId}` : 'Build and qualify fresh artifacts');
}
