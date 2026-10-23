import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { correlatePeekTimings, serviceTiming } from './peek-latency-report.mjs';

const execute = promisify(execFile);
const self = fileURLToPath(import.meta.url);

async function capture(root, output, origin, workspace) {
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8').catch(() => readFile(join(root, 'package.json'), 'utf8')));
  const started = performance.now(), startedAt = new Date().toISOString();
  const requests = [], fetcher = globalThis.fetch;
  let blocked, rendered = '';
  globalThis.fetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : args[0]);
    if (url.protocol === 'data:') return fetcher(...args);
    if (blocked) throw new Error(blocked);
    if (url.origin !== origin) throw new Error('Latency probe refuses a different service origin');
    const request = new Request(...args);
    request.headers.set('X-Juiced-Timing', '1');
    const entry = { path: url.pathname.replace(/\/accounts\/[^/]+/, '/accounts/:account'), startedAt: new Date().toISOString() };
    if (url.pathname.includes('/runtime/commands/')) {
      const envelope = await request.clone().json();
      entry.command = envelope.command?.type;
      entry.messageId = envelope.id;
      if (!['workspace.inspect', 'view', 'stream'].includes(entry.command) &&
          !(entry.command === 'request' && envelope.command.message?.type === 'inspect')) throw new Error('Latency probe only permits workspace inspection commands');
    }
    requests.push(entry);
    const start = performance.now();
    try {
      const response = await fetcher(new Request(request, { redirect: 'error' }));
      entry.headersMs = Math.round(performance.now() - start);
      entry.status = response.status;
      entry.serviceRequestId = response.headers.get('x-request-id');
      entry.serviceTimingMs = serviceTiming(response.headers.get('server-timing'));
      if (response.ok && url.pathname === '/v1/config') {
        const config = await response.clone().json();
        if (config.cliVersion !== release.version) {
          blocked = 'Service recommends a different CLI version; stopped before automatic update';
          throw new Error(blocked);
        }
      }
      if (response.ok && entry.command === 'request') {
        const snapshot = (await response.clone().json()).reply?.inspection;
        if (snapshot?.startedAt && snapshot?.finishedAt) {
          const duration = Date.parse(snapshot.finishedAt) - Date.parse(snapshot.startedAt);
          if (Number.isFinite(duration) && duration >= 0) entry.snapshotMs = duration;
        }
        entry.replyReadyMs = Math.round(performance.now() - start);
      }
      return response;
    } catch (error) {
      entry.failed = true;
      entry.elapsedMs = Math.round(performance.now() - start);
      throw error;
    }
  };
  const write = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    rendered += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    (typeof encoding === 'function' ? encoding : callback)?.();
    return true;
  };
  const entry = join(root, 'bin/juiced.mjs');
  process.argv = [process.execPath, entry, ...(workspace ? ['--workspace', workspace] : []), 'claude', 'peek'];
  try { await import(pathToFileURL(entry).href); }
  finally {
    globalThis.fetch = fetcher;
    process.stdout.write = write;
    await writeFile(output, JSON.stringify({ startedAt, cliVersion: release.version, totalMs: Math.round(performance.now() - started), exitCode: process.exitCode ?? 0, comparisonRendered: /LOCAL\s+REMOTE/.test(rendered), requests, ...(blocked ? { stopped: blocked } : {}) }), { mode: 0o600 });
  }
}

async function configuredOrigin() {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const config = process.env.JUICED_CONFIG_HOME ?? join(base, 'juiced');
  const saved = await readFile(join(config, 'service.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const url = new URL(process.env.JUICED_SERVICE_URL ?? saved?.origin ?? 'https://juiced.codes');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:') throw new Error('The latency probe requires an HTTPS service origin');
  return url.origin;
}

async function main() {
  const options = { samples: 2, command: 'juiced' };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--help') {
      console.log('Usage: npm run measure:peek -- [--samples 1–5] [--command PATH] [--workspace SLUG] [--app CANTELOP_APP_SLUG] [--output PATH]\nRuns the installed managed CLI against the configured service. No model prompt or file upload. The normal command may refresh sign-in and bootstrap the service. Captures timings and request IDs, excluding tokens, filenames and file contents. Optional App traces use the current Cantelop CLI login.');
      return;
    }
    const key = { '--samples': 'samples', '--command': 'command', '--workspace': 'workspace', '--app': 'app', '--output': 'output' }[arg];
    if (!key || !process.argv[i + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    options[key] = key === 'samples' ? Number(process.argv[++i]) : process.argv[++i];
  }
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 5) throw new Error('--samples must be between 1 and 5');
  if (options.app && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.app)) throw new Error('--app requires a Cantelop App slug');
  let command;
  const candidates = options.command.includes('/') ? [resolve(options.command)] : (process.env.PATH ?? '').split(delimiter).map(path => join(path, options.command));
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); command = await realpath(candidate); break; } catch {} }
  if (!command) throw new Error('Cannot find the installed Juiced command');
  const root = dirname(dirname(command));
  await access(join(root, 'bin/juiced.mjs'));
  const portable = join(root, 'lib/node');
  const node = await access(portable, constants.X_OK).then(() => portable, () => process.execPath);
  const origin = await configuredOrigin();
  const temporary = await mkdtemp(join(tmpdir(), 'juiced-peek-latency-'));
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), service: origin, samples: [], limitations: [
    'Instrumented client timings exclude the launcher and Node startup. Reading cloned JSON responses adds small probe overhead.',
    'Platform request time includes the application handler; these overlapping durations must not be added together.',
    'Time outside the platform trace includes network, Juiced authorization/database work, and Fleet connection setup; these are not separated.',
    'Workspace lookup trace matches use a unique one-second-tolerant wall-clock window; inventory matches use exact message IDs.',
    'Empty serviceTimingMs means server instrumentation is unavailable. fleet_connection groups SDK status and credential requests; it does not separate them.',
  ] };
  try {
    for (let i = 0; i < options.samples; i++) {
      const output = join(temporary, `${i}.json`);
      await execute(node, [self, '--internal-profile', root, output, origin, options.workspace ?? ''], { timeout: 45000, maxBuffer: 1024 * 1024 }).catch(error => { if (error.code !== 2) throw new Error(`Peek probe failed (${error.code ?? error.signal ?? 'unknown'}); no response bodies were recorded`); });
      const sample = JSON.parse(await readFile(output, 'utf8'));
      report.samples.push(sample);
      process.stderr.write(`Sample ${i + 1}: ${sample.totalMs} ms; command exit ${sample.exitCode}\n`);
    }
    if (options.app) {
      const config = join(temporary, 'cantelop.json');
      await writeFile(join(temporary, 'noop.ts'), 'export {};\n');
      await writeFile(config, JSON.stringify({ app: options.app, api: { entrypoint: 'noop.ts' }, session: { entrypoint: 'noop.ts' } }));
      const traces = JSON.parse((await execute('cantelop', ['traces', '--config', config, '--json'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      for (const sample of report.samples) sample.platform = correlatePeekTimings(sample, traces);
    }
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options.output) await writeFile(resolve(options.output), json, { mode: 0o600 });
    else process.stdout.write(json);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[2] === '--internal-profile') await capture(...process.argv.slice(3));
else await main();
