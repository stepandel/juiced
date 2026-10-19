import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.cantelop'), { recursive: true });
const buildDirectory = await mkdtemp(join(root, '.cantelop', 'delete-live-'));
const local = await mkdtemp(join(tmpdir(), 'juiced-delete-live-'));
// Never accept a caller-selected workspace: only this run's random fixture
// can be provisioned or deleted by the live check.
const slug = `juiced-delete-live-${randomUUID().replaceAll('-', '')}`;
const execute = promisify(execFile);
const owned = new Set();
const sdk = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@cantelop/sdk')), 'utf8')).version;
const report = { date: new Date().toISOString(), sdk, slug, checks: [] };
const passed = message => { report.checks.push(message); console.log(`PASS: ${message}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(label, check) {
  const started = Date.now();
  let lastNotice = started, lastError;
  while (Date.now() - started < 120_000) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    if (Date.now() - lastNotice > 15_000) { console.log(`Waiting for ${label}…`); lastNotice = Date.now(); }
    await pause(1500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}
let app, failure, requestedProvision = false, initialAbsent = false;
try {
  await build({ stdin: { contents: "export { app } from './src/cantelop.ts';", resolveDir: root, sourcefile: 'delete-live.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [createCantelopCompilerPlugin({ definition: join(root, 'src/cantelop.ts') })], outfile: join(buildDirectory, 'app.mjs') });
  ({ app } = await import(pathToFileURL(join(buildDirectory, 'app.mjs')).href));
  const inspect = selector => app.workspace(selector).inspect({ signal: AbortSignal.timeout(30_000) });
  assert.equal(await inspect({ slug }), undefined);
  initialAbsent = true;
  passed('read-only inspection of a missing workspace succeeds without provisioning');
  await mkdir(join(local, 'empty-bin'));
  await writeFile(join(local, 'keep.txt'), 'local files stay local\n');
  // Keep the SDK's existing app profile while making account credentials and
  // command lookup unavailable to the child CLI.
  const configDirectory = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const integrationProfile = process.env.CANTELOP_INTEGRATION_CONFIG ?? (process.env.CANTELOP_CONFIG
    ? join(dirname(process.env.CANTELOP_CONFIG), 'integration.json') : configDirectory && join(configDirectory, 'cantelop', 'integration.json'));
  const env = { ...process.env, PATH: join(local, 'empty-bin'), CANTELOP_CONFIG: join(local, 'no-account-credentials.json'),
    ...(integrationProfile ? { CANTELOP_INTEGRATION_CONFIG: resolve(integrationProfile) } : {}) };
  const runDelete = argv => execute(process.execPath, [join(root, 'bin/juiced.mjs'), '--workspace', slug, 'claude', 'delete', ...argv], { cwd: local, env, timeout: 60_000 });
  assert.match((await runDelete(['--yes'])).stderr, /does not exist/);
  assert.equal(await inspect({ slug }), undefined);
  passed('CLI deletion of an absent workspace is a no-op with an empty PATH');

  requestedProvision = true;
  const original = await app.workspace({ slug }).resolve(); owned.add(original.id);
  report.originalId = original.id;
  await waitUntil('fixture registration', async () => (await inspect({ slug }))?.id === original.id);
  const originalRef = app.workspace({ id: original.id });
  let database;
  await waitUntil('fixture database', async () => {
    database?.close(); database = await originalRef.database();
    await database.execute('CREATE TABLE IF NOT EXISTS juiced_delete_probe (value TEXT NOT NULL)');
    return true;
  });
  try { await database.execute({ sql: 'INSERT INTO juiced_delete_probe (value) VALUES (?)', args: [slug] }); }
  finally { database.close(); }
  passed('disposable workspace and managed database fixture created');
  await assert.rejects(runDelete([]), error => /Pass --yes/.test(error.stderr));
  assert.equal((await inspect({ slug }))?.id, original.id);
  passed('noninteractive deletion without --yes preserves the workspace');
  const deleted = await runDelete(['--yes']);
  assert.match(deleted.stderr, /Deletion requested/); assert.ok(deleted.stderr.includes(original.id));
  await waitUntil('original workspace admission closure', async () => (await inspect({ id: original.id })) === undefined && (await inspect({ slug })) === undefined);
  passed('CLI deletion closes access to the original workspace without a Cantelop CLI or account login');

  const replacement = await app.workspace({ slug }).resolve(); owned.add(replacement.id);
  assert.notEqual(replacement.id, original.id); report.replacementId = replacement.id;
  await waitUntil('replacement registration', async () => (await inspect({ slug }))?.id === replacement.id);
  const replacementRef = app.workspace({ id: replacement.id });
  await waitUntil('replacement database', async () => {
    database?.close(); database = await replacementRef.database();
    await database.execute('SELECT 1'); return true;
  });
  try {
    const tables = await database.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'juiced_delete_probe'");
    assert.equal(tables.rows.length, 0);
  } finally { database.close(); }
  passed('reusing the slug creates a different workspace with a fresh database');
  const retry = await originalRef.delete({ signal: AbortSignal.timeout(30_000) });
  assert.equal(retry.id, original.id);
  assert.equal((await inspect({ slug }))?.id, replacement.id);
  passed('retrying deletion of the old canonical ID leaves its replacement intact');
  assert.equal(await readFile(join(local, 'keep.txt'), 'utf8'), 'local files stay local\n');
  passed('local project files remain unchanged');
  await replacementRef.delete({ signal: AbortSignal.timeout(30_000) });
  await waitUntil('fixture cleanup', async () => (await inspect({ slug })) === undefined);
  passed('disposable replacement workspace archived and purge requested');
  report.outcome = 'passed';
} catch (error) {
  failure = error;
  report.outcome = 'failed';
  report.errorCode = error.code ?? error.name;
  throw error;
} finally {
  const cleanupErrors = [];
  if (app && initialAbsent && requestedProvision) {
    try {
      const remaining = await app.workspace({ slug }).inspect({ signal: AbortSignal.timeout(30_000) });
      if (remaining) owned.add(remaining.id);
    } catch (error) { cleanupErrors.push(error); }
    for (const id of owned) {
      try { await app.workspace({ id }).delete({ signal: AbortSignal.timeout(30_000) }); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  await rm(local, { recursive: true, force: true });
  await rm(buildDirectory, { recursive: true, force: true });
  if (cleanupErrors.length) {
    report.outcome = 'failed';
    report.cleanupErrorCodes = cleanupErrors.map(error => error.code ?? error.name);
  }
  if (process.env.JUICED_DELETE_REPORT) await writeFile(process.env.JUICED_DELETE_REPORT, JSON.stringify(report, null, 2) + '\n');
  if (cleanupErrors.length && !failure) throw new AggregateError(cleanupErrors, 'Disposable workspace cleanup failed');
}
