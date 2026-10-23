import assert from 'node:assert/strict';
import childProcess, { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execute = promisify(execFile), project = fileURLToPath(new URL('../', import.meta.url));
const options = { baseline: 'HEAD' };
for (let i = 2; i < process.argv.length; i++) {
  const key = { '--baseline': 'baseline', '--output': 'output' }[process.argv[i]];
  if (!key || !process.argv[i + 1]) throw new Error('Usage: node scripts/benchmark-inspection.mjs [--baseline REF] [--output PATH]');
  options[key] = process.argv[++i];
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(options.baseline)) throw new Error('Invalid baseline ref');
const baseline = (await execute('git', ['rev-parse', '--verify', `${options.baseline}^{commit}`], { cwd: project })).stdout.trim();
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'juiced-inspection-benchmark-')));
const originalSpawn = childProcess.spawn;
let activeProfile;
// Profile the real Git children in both bundles without instrumenting production
// code. Intervals overlap: their durations must not be added to capture latency.
childProcess.spawn = function (command, args, options) {
  const profile = activeProfile, start = performance.now(), child = originalSpawn(command, args, options);
  if (command === 'git' && profile) child.once('close', () => {
    const commandIndex = args.findIndex(arg => ['rev-parse', 'symbolic-ref', 'config', 'ls-files', 'check-attr', 'update-index', 'add', 'write-tree', 'ls-tree', 'diff', 'check-ignore'].includes(arg));
    profile.commands.push({ command: args.slice(commandIndex).join(' '), startMs: Math.round(start - profile.start), durationMs: Math.round(performance.now() - start) });
  });
  return child;
};
syncBuiltinESMExports();
try {
  const modules = {};
  for (const name of ['baseline', 'candidate']) {
    const outfile = join(temporary, `${name}.mjs`);
    await build({ entryPoints: [join(project, 'src/inspection-snapshot.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile,
      plugins: name === 'baseline' ? [{ name: 'baseline-sources', setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          const source = relative(project, path);
          if (source.startsWith('../')) return;
          return { contents: (await execute('git', ['show', `${baseline}:${source}`], { cwd: project })).stdout, loader: 'ts' };
        });
      } }] : [],
    });
    modules[name] = await import(pathToFileURL(outfile).href);
  }
  const clean = snapshot => { const { startedAt, finishedAt, ...contents } = snapshot; return contents; };
  const fixtures = [];
  for (const fixture of [
    { name: 'small files', fileCount: 256, bytesPerFile: 128, directories: 1 },
    { name: 'large files', fileCount: 256, bytesPerFile: 256 * 1024, directories: 1 },
    { name: 'nested files', fileCount: 1024, bytesPerFile: 128, directories: 64 },
  ]) {
    const root = join(temporary, `fixture-${fixtures.length}`); await mkdir(root);
    const git = async (...args) => (await execute('git', ['-C', root, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Inspection Benchmark'); await git('config', 'user.email', 'benchmark@example.test');
    const path = i => join(root, ...(fixture.directories > 1 ? [`dir-${i % fixture.directories}`] : []), `file-${i}.bin`);
    for (let i = 0; i < fixture.fileCount; i++) { await mkdir(dirname(path(i)), { recursive: true }); await writeFile(path(i), randomBytes(fixture.bytesPerFile)); }
    await git('add', '.'); await git('commit', '-m', 'fixture');
    const indexBefore = await readFile(join(root, '.git/index'));
    const scenarios = [];
    for (const scenario of ['clean', 'one dirty file']) {
      if (scenario !== 'clean') await writeFile(path(0), randomBytes(fixture.bytesPerFile));
      const measurements = { baseline: [], candidate: [] }, profiles = { baseline: [], candidate: [] };
      for (let round = 0; round < 5; round++) {
        const snapshots = {};
        for (const name of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const start = performance.now();
          activeProfile = { start, commands: [] };
          snapshots[name] = await modules[name].captureInspection(root, '', false, new AbortController().signal);
          measurements[name].push(Math.round(performance.now() - start));
          profiles[name].push(activeProfile.commands.sort((a, b) => a.startMs - b.startMs));
          activeProfile = undefined;
        }
        assert.deepEqual(clean(snapshots.candidate), clean(snapshots.baseline));
        assert.deepEqual(await readFile(join(root, '.git/index')), indexBefore);
      }
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      scenarios.push({ scenario, measurementsMs: measurements,
        medianMs: { baseline: median(measurements.baseline), candidate: median(measurements.candidate) },
        // Some runtimes do not update named imports via syncBuiltinESMExports.
        // Missing instrumentation is unavailable, never zero Git processes.
        gitProcesses: { baseline: profiles.baseline.map(commands => commands.length || null), candidate: profiles.candidate.map(commands => commands.length || null) },
        firstSampleGitTimeline: { baseline: profiles.baseline[0].length ? profiles.baseline[0] : null, candidate: profiles.candidate[0].length ? profiles.candidate[0] : null },
      });
    }
    fixtures.push({ ...fixture, totalBytes: fixture.fileCount * fixture.bytesPerFile, scenarios });
  }
  const digest = createHash('sha256');
  for (const file of ['src/inspection-snapshot.ts', 'src/inspection-index.ts', 'src/inspection-git.ts']) digest.update(file).update(await readFile(join(project, file)));
  const report = { schemaVersion: 2, measuredAt: new Date().toISOString(), baselineCommit: baseline, candidateSourceSha256: digest.digest('hex'), platform: process.platform, nodeVersion: process.version, fixtures,
    runtime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.version },
    verification: 'Every candidate snapshot equaled its baseline; the real index remained byte-for-byte unchanged.',
    limitations: ['Local disposable filesystem fixtures, not production end-to-end latency.', 'Five alternating pairs per scenario; no latency percentiles or cold-storage guarantee.', 'Git command intervals overlap and must not be added together.', 'Null Git process counts or timelines mean the runtime did not support child-process instrumentation.'],
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) await writeFile(options.output, json);
  process.stdout.write(json);
} finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await rm(temporary, { recursive: true, force: true }); }
