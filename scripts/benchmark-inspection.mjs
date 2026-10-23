import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
const git = async (...args) => (await execute('git', ['-C', join(temporary, 'fixture'), ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
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
  const root = join(temporary, 'fixture'); await mkdir(root);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Inspection Benchmark'); await git('config', 'user.email', 'benchmark@example.test');
  const fileCount = 256, bytesPerFile = 256 * 1024;
  for (let i = 0; i < fileCount; i++) await writeFile(join(root, `file-${i}.bin`), randomBytes(bytesPerFile));
  await git('add', '.'); await git('commit', '-m', 'fixture');
  const indexBefore = await readFile(join(root, '.git/index'));
  const clean = snapshot => { const { startedAt, finishedAt, ...contents } = snapshot; return contents; };
  const scenarios = [];
  for (const scenario of ['clean', 'one dirty file']) {
    if (scenario !== 'clean') await writeFile(join(root, 'file-0.bin'), randomBytes(bytesPerFile));
    const measurements = { baseline: [], candidate: [] };
    for (let round = 0; round < 3; round++) {
      const snapshots = {};
      for (const name of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const start = performance.now();
        snapshots[name] = await modules[name].captureInspection(root, '', false, new AbortController().signal);
        measurements[name].push(Math.round(performance.now() - start));
      }
      assert.deepEqual(clean(snapshots.candidate), clean(snapshots.baseline));
      assert.deepEqual(await readFile(join(root, '.git/index')), indexBefore);
    }
    const median = values => [...values].sort((a, b) => a - b)[1];
    scenarios.push({ scenario, measurementsMs: measurements, medianMs: { baseline: median(measurements.baseline), candidate: median(measurements.candidate) } });
  }
  const digest = createHash('sha256');
  for (const file of ['src/inspection-snapshot.ts', 'src/inspection-index.ts', 'src/inspection-git.ts']) digest.update(file).update(await readFile(join(project, file)));
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), baselineCommit: baseline, candidateSourceSha256: digest.digest('hex'), platform: process.platform, nodeVersion: process.version,
    fixture: { fileCount, bytesPerFile, totalBytes: fileCount * bytesPerFile }, scenarios,
    verification: 'Every candidate snapshot equaled its baseline; the real index remained byte-for-byte unchanged.',
    limitations: ['Local disposable filesystem fixture, not production end-to-end latency.', 'Three alternating pairs per scenario; no latency percentiles or cold-storage guarantee.'],
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) await writeFile(options.output, json);
  process.stdout.write(json);
} finally { await rm(temporary, { recursive: true, force: true }); }
