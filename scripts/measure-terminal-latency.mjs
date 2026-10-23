import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let samples = 10;
let workspaceSlug = process.env.JUICED_WORKSPACE ?? 'default';
let outputPath;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') {
    console.log('Usage: npm run measure:latency -- [--samples 1–30] [--workspace SLUG] [--output PATH]\nMeasures a fresh Claude terminal using unsent text; no model prompt is submitted.');
    process.exit(0);
  } else if (args[i] === '--samples') samples = Number(args[++i]);
  else if (args[i] === '--workspace') workspaceSlug = args[++i];
  else if (args[i] === '--output') {
    outputPath = args[++i];
    if (!outputPath) throw new Error('--output requires a path');
  } else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('--samples must be an integer from 1 to 30');
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspaceSlug)) throw new Error('Invalid workspace slug');

await mkdir(join(root, '.cantelop'), { recursive: true });
const temporary = await mkdtemp(join(root, '.cantelop', 'latency-'));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('Latency measurement deadline exceeded')), 180_000);
const interrupt = () => controller.abort(new Error('Latency measurement interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let session;
let streaming;
let screen = '';
let activeEcho;
let exited = false;
const requests = [];
const echoes = [];
const signal = controller.signal;
async function until(check, timeoutMs = 15_000) {
  const start = performance.now();
  while (!check()) {
    signal.throwIfAborted();
    if (exited) throw new Error('The remote terminal exited during measurement');
    if (performance.now() - start > timeoutMs) throw new Error('Timed out waiting for the remote terminal');
    await delay(5, undefined, { signal });
  }
}
try {
  await build({
    stdin: { contents: `export { app } from ${JSON.stringify(join(root, 'src/app.ts'))};`, resolveDir: root, sourcefile: 'latency-entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [createCantelopCompilerPlugin({ definition: join(root, 'src/cantelop.ts') })], outfile: join(temporary, 'app.mjs'),
  });
  const { app } = await import(pathToFileURL(join(temporary, 'app.mjs')).href);
  const workspace = await app.workspace({ slug: workspaceSlug }).resolve();
  session = app.workspace({ id: workspace.id }).session({ keepAliveSeconds: 120 });
  const bySlug = app.workspace({ slug: workspaceSlug }).session({ id: session.id, keepAliveSeconds: 120 });
  async function send(command, selector = 'id') {
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const submittedAt = Date.now();
    const start = performance.now();
    const reply = await (selector === 'slug' ? bySlug : session).request(command, { id, timeoutMs: 30_000, signal });
    if (reply?.ok !== true) throw new Error('The terminal rejected the probe');
    const request = { type: command.type, selector, id, submittedAt, acknowledgementMs: Math.round(performance.now() - start) };
    requests.push(request);
    return request;
  }
  await send({ type: 'start', argv: [], tty: true, columns: 120, rows: 36, term: 'xterm-256color' });
  streaming = (async () => {
    for await (const event of session.stream({ signal })) {
      if (event.data.type === 'exit') exited = true;
      if (event.data.type !== 'output') continue;
      screen += Buffer.from(event.data.data, 'base64').toString();
      if (activeEcho && !activeEcho.result && stripVTControlCharacters(screen.slice(activeEcho.offset)).includes(activeEcho.marker)) {
        activeEcho.result = { visibleMs: Math.round(performance.now() - activeEcho.start), eventCreatedAt: event.createdAt.toISOString(), eventReceivedAt: Date.now(), sequence: event.cursor.sequence };
      }
    }
  })();
  void streaming.catch(error => { if (!signal.aborted) controller.abort(error); });
  await until(() => /Yes,.*trust.*folder|Claude.*Code/i.test(stripVTControlCharacters(screen)), 30_000);
  await delay(500, undefined, { signal });
  if (/Yes,.*trust.*folder/i.test(stripVTControlCharacters(screen))) {
    // The same user-owned workspace already used by juiced claude.
    await send({ type: 'input', data: Buffer.from('\x1b[B').toString('base64') });
    await send({ type: 'input', data: Buffer.from('\r').toString('base64') });
    await delay(2500, undefined, { signal });
  }
  for (let i = 0; i < 4; i++) {
    await send({ type: 'heartbeat' }, i % 2 ? 'slug' : 'id');
    await delay(85 + i * 23, undefined, { signal });
  }
  for (let i = 0; i < samples; i++) {
    const selector = i % 2 ? 'slug' : 'id';
    const marker = `qv${i}zx`;
    activeEcho = { marker, offset: screen.length, start: performance.now() };
    const acknowledgement = send({ type: 'input', data: Buffer.from(marker).toString('base64') }, selector);
    void acknowledgement.catch(error => controller.abort(error));
    await until(() => activeEcho.result !== undefined);
    const request = await acknowledgement;
    const result = { sample: i, selector, ...request, ...activeEcho.result };
    echoes.push(result);
    process.stderr.write(`Sample ${i + 1}: visible ${result.visibleMs} ms; acknowledgement ${result.acknowledgementMs} ms\n`);
    activeEcho = undefined;
    await delay(180, undefined, { signal });
  }
  const sdk = JSON.parse(await readFile(join(root, 'node_modules/@cantelop/sdk/package.json'), 'utf8'));
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), sdkVersion: sdk.version, sessionId: session.id, workspaceId: workspace.id,
    method: 'One input batch at a time over the real SDK request/SSE path; synthetic text is never submitted. Excludes local input batching and waiting behind earlier input.',
    clockCaution: 'Elapsed durations use a monotonic client clock. Comparing eventCreatedAt with client timestamps requires synchronized clocks.', requests, echoes };
  if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  else console.log(JSON.stringify(report, null, 2));
} finally {
  controller.abort();
  clearTimeout(timeout);
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  if (session) {
    const cleanup = session.stop();
    await Promise.race([cleanup, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Session cleanup timed out'); })])
      .catch(() => process.stderr.write('Could not stop the probe session; its renewable terminal lease expires within 90 seconds.\n'));
  }
  await streaming?.catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
