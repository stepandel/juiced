import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CliUpdater, needsCliUpdate } from '../src/update.js';
import { VERSION } from '../src/version.js';

const signal = () => new AbortController().signal;
function latest(version = '0.2.2', origin = 'https://github.com') {
  return Object.defineProperty(new Response(null), 'url', {
    value: `${origin}/stepandel/juiced/releases/tag/v${version}`,
  });
}

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "juiced update's ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'custom data'), binDir = join(root, 'custom bin');
  const old = join(installDir, 'releases/old');
  await mkdir(join(old, 'bin'), { recursive: true });
  await mkdir(binDir);
  await writeFile(join(old, 'release.json'), JSON.stringify({ version: '0.2.1', platform: process.platform, arch: process.arch }));
  await writeFile(join(old, 'install-paths'), `${installDir}\0${binDir}\0`);
  const entry = join(old, 'bin/juiced.mjs'), command = join(binDir, 'juiced');
  await writeFile(entry, '');
  await writeFile(join(old, 'bin/juiced'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlink(join(old, 'bin/juiced'), command);
  const installerPath = join(root, 'installer.mjs');
  await writeFile(installerPath, `
import assert from 'node:assert/strict';
import { appendFile, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
assert.equal(process.env.JUICED_INSTALL_DIR, ${JSON.stringify(installDir)});
assert.equal(process.env.JUICED_BIN_DIR, ${JSON.stringify(binDir)});
const version = process.argv[2];
await appendFile(process.env.FIXTURE_REQUESTS, version + '\\n');
await new Promise(resolve => setTimeout(resolve, 100));
const root = join(process.env.JUICED_INSTALL_DIR, 'releases', version);
await mkdir(join(root, 'bin'), { recursive: true });
await writeFile(join(root, 'release.json'), JSON.stringify({version, platform:process.platform, arch:process.arch}));
await writeFile(join(root, 'bin/juiced'), '#!/bin/sh\\nexit 0\\n', {mode:0o755});
const temp = join(process.env.JUICED_BIN_DIR, 'new-link');
await symlink(join(root, 'bin/juiced'), temp);
await rename(temp, join(process.env.JUICED_BIN_DIR, 'juiced'));
`);
  const env = { ...process.env, HOME: root, JUICED_BIN_DIR: undefined,
    FIXTURE_NODE: process.execPath, FIXTURE_INSTALLER: installerPath,
    FIXTURE_REQUESTS: join(root, 'requests') };
  let requests = 0, output = '';
  const options = {
    env, entry, version: '0.2.1',
    fetcher: (async (url, init) => {
      requests++;
      assert.equal(url, 'https://github.com/stepandel/juiced/releases/latest');
      assert.equal(init?.method, 'HEAD');
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return latest();
    }) as typeof fetch,
    installer: 'exec "$FIXTURE_NODE" "$FIXTURE_INSTALLER" "$@"\n',
    write: (text: string) => { output += text; },
  };
  return { root, old, entry, command, options, requests: () => requests, output: () => output };
}

test('concurrent startup updates preserve a custom installation and install only once', async t => {
  const f = await fixture(t);
  const results = await Promise.all([new CliUpdater(f.options).check(signal()), new CliUpdater(f.options).check(signal())]);
  assert.deepEqual(results, [f.command, f.command]);
  assert.equal(await readFile(f.options.env.FIXTURE_REQUESTS, 'utf8'), '0.2.2\n');
  assert.match(await readlink(f.command), /releases\/0\.2\.2\/bin\/juiced$/);
  assert.equal(JSON.parse(await readFile(join(f.old, 'release.json'), 'utf8')).version, '0.2.1');
  assert.match(f.output(), /Updating 0\.2\.1 → 0\.2\.2/);
});

test('unavailable updates preserve the old CLI and required updates give executable instructions', async t => {
  const f = await fixture(t), before = await readlink(f.command);
  const updater = new CliUpdater({ ...f.options, fetcher: async () => { throw new Error('Network unavailable'); } });
  assert.equal(await updater.check(signal()), undefined);
  assert.match(f.output(), /Automatic update unavailable.*Network unavailable/);
  await assert.rejects(updater.check(signal(), 'mismatch'), /Network unavailable[\s\S]*juiced update[\s\S]*curl -fsSL https:\/\/juiced.codes\/install.sh \| sh/);
  assert.equal(await readlink(f.command), before);
});

test('a failed installer preserves the command and is never retried recursively', async t => {
  const f = await fixture(t), before = await readlink(f.command);
  const updater = new CliUpdater({ ...f.options, installer: 'echo "checksum failed" >&2\nexit 1\n' });
  await assert.rejects(updater.check(signal(), 'manual'), /release installer failed[\s\S]*juiced update/);
  assert.equal(await readlink(f.command), before);
  await assert.rejects(updater.check(signal(), 'mismatch'), /already attempted/);
  assert.equal(f.requests(), 1);
  assert.match(f.output(), /checksum failed/);
});

test('current releases report a service mismatch and prereleases are never silently downgraded', async t => {
  const f = await fixture(t);
  const updater = new CliUpdater({ ...f.options, fetcher: async () => latest('0.2.1') });
  assert.equal(await updater.check(signal(), 'manual'), undefined);
  assert.match(f.output(), /0\.2\.1 is up to date/);
  await assert.rejects(updater.check(signal(), 'mismatch'), /recommended release[\s\S]*matching service\/CLI release/);
  const rc = { version: '0.3.0-rc.1', platform: process.platform, arch: process.arch };
  await writeFile(join(f.old, 'release.json'), JSON.stringify(rc));
  assert.equal(await new CliUpdater({ ...f.options, version: rc.version }).check(signal()), undefined);
  assert.equal(await readlink(f.command), join(f.old, 'bin/juiced'));
});

test('source installs, foreign release URLs and unrelated commands cannot be overwritten', async t => {
  const f = await fixture(t);
  const source = join(f.root, 'source/bin/juiced.mjs');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, '');
  const updater = new CliUpdater({ ...f.options, entry: source });
  assert.equal(await updater.check(signal()), undefined);
  assert.equal(f.requests(), 0);
  await assert.rejects(updater.check(signal(), 'manual'), /source or package-manager installation[\s\S]*npm run build/);
  for (const response of [latest('0.2.2', 'https://other.example'), latest('0.2.2-rc.1'), latest('invalid')])
    await assert.rejects(new CliUpdater({ ...f.options, fetcher: async () => response }).check(signal(), 'manual'), /Could not resolve/);
  await rm(f.command);
  await symlink(source, f.command);
  await assert.rejects(new CliUpdater(f.options).check(signal(), 'manual'), /not owned by this installation/);
});

test('the restarted process skips updates and cancellation remains cancellation', async t => {
  const f = await fixture(t);
  const updater = new CliUpdater({ ...f.options, env: { ...f.options.env, JUICED_UPDATE_ATTEMPTED: '0.2.0' } });
  assert.equal(await updater.check(signal()), undefined);
  await assert.rejects(updater.check(signal(), 'mismatch'), /already attempted/);
  assert.equal(f.requests(), 0);
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await assert.rejects(new CliUpdater({ ...f.options, fetcher: async () => { throw new Error('fetch aborted'); } }).check(controller.signal), /Cancelled/);
  assert.equal(needsCliUpdate({ code: 'cli_upgrade_required' }), true);
  assert.equal(needsCliUpdate({ code: 'session_runtime_mismatch' }), true);
  assert.equal(needsCliUpdate({ code: 'not_signed_in' }), false);
  assert.equal(needsCliUpdate(Object.assign(new Error('submission failed', { cause: { code: 'cli_upgrade_required' } }), { code: 'command_outcome_unknown' })), true);
  const cycle = { cause: undefined as unknown }; cycle.cause = cycle;
  assert.equal(needsCliUpdate(cycle), false);
});

test('process replacement preserves arguments, stdin, cwd, shell parent and exit status', async t => {
  const f = await fixture(t);
  const replacement = join(f.root, 'replacement.mjs');
  await writeFile(replacement, `
let input = ''; for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ args:process.argv.slice(2), input, cwd:process.cwd(), parent:process.ppid, marker:process.env.JUICED_UPDATE_ATTEMPTED }));
process.exitCode = 7;
`);
  const command = join(f.root, 'command');
  // Keep paths in environment variables, including apostrophes and spaces.
  await writeFile(command, '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_REPLACEMENT" "$@"\n', { mode: 0o755 });
  const runner = join(f.root, 'runner.mjs');
  await writeFile(runner, `import { CliUpdater } from ${JSON.stringify(new URL('../src/update.ts', import.meta.url).href)}; await new CliUpdater().restart(process.env.FIXTURE_COMMAND, new AbortController().signal);`);
  const args = ['--account', 'acc_' + 'a'.repeat(32), 'claude', '--', "literal's prompt", '--version'];
  const child = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), runner, ...args], {
    cwd: f.root,
    env: { ...f.options.env, FIXTURE_REPLACEMENT: replacement, FIXTURE_COMMAND: command },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end('secret piped input\n');
  const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', accept); });
  assert.equal(code, 7, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.args, args);
  assert.equal(result.input, 'secret piped input\n');
  assert.equal(result.cwd, f.root);
  if (process.execve) assert.equal(result.parent, process.pid);
  assert.equal(result.marker, VERSION);
});

test('managed updates use the service-approved CLI instead of a newer unqualified GitHub release', async t => {
  const f = await fixture(t);
  let requests = 0;
  const options = { ...f.options, serviceOrigin: 'https://managed.example', fetcher: (async (url, init) => {
    requests++;
    assert.equal(String(url), 'https://managed.example/v1/config');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({ cliVersion: '0.2.1' });
  }) as typeof fetch };
  assert.equal(await new CliUpdater(options).check(signal()), undefined);
  assert.equal(requests, 1);
  assert.equal(await readlink(f.command), join(f.old, 'bin/juiced'));
  await assert.rejects(new CliUpdater({ ...options, fetcher: async () => Response.json({ cliVersion: 'invalid' }) }).check(signal(), 'manual'), /invalid CLI release/);
  await assert.rejects(new CliUpdater({ ...options, fetcher: async () => new Response(null, { status: 503 }) }).check(signal(), 'manual'), /HTTP 503/);
  const updater = new CliUpdater({ ...options, fetcher: async () => Response.json({ cliVersion: '0.2.2' }) });
  assert.equal(await updater.check(signal(), 'mismatch'), f.command);
});
