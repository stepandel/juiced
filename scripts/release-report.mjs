import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const stageNames = [
  'cli-artifacts', 'runtime-preflight', 'publish-cli', 'deploy-runtime',
  'qualify-runtime', 'deploy-service', 'resume-rollout', 'promote', 'verify-live',
];
const jobNames = new Set(['prepared', 'qualified',
  ...['ubuntu-22.04', 'ubuntu-22.04-arm', 'macos-14'].map(r => `native-tests (${r}, 1/1, 4)`),
  ...['1/2', '2/2'].map(s => `native-tests (macos-15-intel, ${s}, 1)`),
  ...[['ubuntu-22.04', 'linux-x64'], ['ubuntu-22.04-arm', 'linux-arm64'],
    ['macos-14', 'darwin-arm64'], ['macos-15-intel', 'darwin-x64']].map(([r, t]) => `package (${r}, ${t})`),
]);
const duration = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const difference = (end, start) => end !== null && start !== null ? duration(end - start) : null;
const interval = entry => {
  const end = timestamp(entry.completedAt), length = duration(entry.durationMs);
  return end !== null && length !== null ? [end - length, end] : null;
};
function activeTime(intervals) {
  let total = 0, until = -Infinity;
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, end - Math.max(start, until));
    until = Math.max(until, end);
  }
  return total;
}

// GitHub exposes job start times, not runner queue-entry times. Scheduling delay
// is measured from dependency completion and includes orchestration overhead.
export function preparationTiming(run, jobs) {
  const known = jobs.filter(j => jobNames.has(j.name) && j.conclusion === 'success');
  const prepared = known.find(j => j.name === 'prepared');
  const buildEnds = known.filter(j => j.name !== 'qualified').map(j => timestamp(j.completed_at)).filter(t => t !== null);
  const timings = known.map(j => {
    const ready = j.name === 'prepared' ? timestamp(run.created_at)
      : j.name === 'qualified' ? (buildEnds.length ? Math.max(...buildEnds) : null)
      : timestamp(prepared?.completed_at);
    return { name: j.name, schedulingDelayMs: difference(timestamp(j.started_at), ready),
      durationMs: difference(timestamp(j.completed_at), timestamp(j.started_at)) };
  });
  const qualified = known.find(j => j.name === 'qualified');
  return { durationMs: difference(timestamp(qualified?.completed_at), timestamp(run.created_at)), jobs: timings };
}

// Construct every exported field explicitly. Private state, logs and provider
// responses may contain credentials or account details and must never be copied.
export function releaseReport(state) {
  assert.ok(typeof state.commit === 'string' && /^[a-f0-9]{40}$/.test(state.commit), 'Invalid receipt commit');
  assert.ok(typeof state.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(state.version), 'Invalid receipt version');
  const completed = state.completed ?? {}, attempts = state.attempts ?? [];
  const stages = stageNames.map(name => {
    const entries = attempts.filter(a => a.name === name && ['success', 'failure'].includes(a.status));
    const entry = completed[name];
    return { name, status: entry ? 'complete' : entries.length ? 'failed' : 'pending',
      durationMs: entry ? duration(entry.durationMs) : null,
      failedAttempts: entries.filter(a => a.status === 'failure').length,
      failedDurationMs: entries.filter(a => a.status === 'failure').reduce((n, a) => n + (duration(a.durationMs) ?? 0), 0) };
  });
  const intervals = stageNames.flatMap(name => {
    const recorded = attempts.filter(a => a.name === name && ['success', 'failure'].includes(a.status)).map(interval).filter(Boolean);
    // Older receipts have only completion records. Include them, but do not
    // count a successful attempt twice when the new attempt journal is present.
    if (completed[name]) recorded.push(interval(completed[name]));
    return recorded.filter(Boolean);
  });
  const ci = state.ciTiming;
  const preparation = ci ? { durationMs: duration(ci.durationMs),
    jobs: (ci.jobs ?? []).filter(j => jobNames.has(j.name)).map(j => ({ name: j.name,
      schedulingDelayMs: duration(j.schedulingDelayMs), durationMs: duration(j.durationMs) })) } : null;
  const invocations = (state.invocations ?? []).filter(i => ['prepare', 'ship'].includes(i.mode) && ['success', 'failure'].includes(i.status));
  return { schemaVersion: 1, version: state.version, commit: state.commit,
    operatorActiveMs: invocations.length ? activeTime(invocations.map(interval).filter(Boolean)) : null,
    operatorAttempts: invocations.map(i => ({ mode: i.mode, status: i.status, durationMs: duration(i.durationMs) })),
    status: completed['verify-live'] ? 'shipped' : stages.slice(0, 2).every(s => s.status === 'complete') ? 'prepared' : 'partial',
    recordedActiveMs: activeTime(intervals), preparation, stages };
}
const seconds = n => n === null ? 'unavailable' : `${(n / 1000).toFixed(1)}s`;
export function formatReleaseReport(report) {
  const lines = [`Release ${report.version} (${report.commit.slice(0, 12)}): ${report.status}`,
    `Operator time: ${seconds(report.operatorActiveMs)} (all recorded attempts; pauses between commands excluded)`,
    `Recorded stage time: ${seconds(report.recordedActiveMs)} (overlapping work counted once; pauses and preflight excluded)`];
  if (report.preparation) {
    lines.push(`CI preparation: ${seconds(report.preparation.durationMs)}`, '', '| CI job | Scheduling delay | Run time |', '| --- | ---: | ---: |');
    for (const job of report.preparation.jobs) lines.push(`| ${job.name} | ${seconds(job.schedulingDelayMs)} | ${seconds(job.durationMs)} |`);
  } else lines.push('CI timing: unavailable in this receipt');
  lines.push('', '| Release stage | Status | Time | Failed attempts | Failed time |', '| --- | --- | ---: | ---: | ---: |');
  for (const s of report.stages) lines.push(`| ${s.name} | ${s.status} | ${seconds(s.durationMs)} | ${s.failedAttempts} | ${seconds(s.failedDurationMs)} |`);
  return lines.join('\n') + '\n';
}
export async function writeReleaseReport(directory, state) {
  const report = releaseReport(state);
  await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'summary.md'), formatReleaseReport(report), { mode: 0o600 });
  return report;
}
