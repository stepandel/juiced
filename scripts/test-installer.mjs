import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const installer = await readFile(new URL('../service/public/install.sh', import.meta.url), 'utf8');
const launcher = await readFile(new URL('./release-launcher.sh', import.meta.url), 'utf8');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const actualArchive = process.argv[2] && resolve(process.argv[2]);
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;

async function fixture(t) {
  // Apostrophes and spaces catch accidental interpolation into generated shells.
  const directory = await mkdtemp(join(tmpdir(), "juiced install's "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = join(directory, 'tools');
  const assets = join(directory, 'assets');
  const install = join(directory, 'data', 'juiced');
  const bin = join(directory, 'bin');
  await mkdir(tools);
  await mkdir(assets);
  for (const name of ['tar', 'gzip', 'mktemp', 'uname', 'awk', 'grep', 'shasum', 'mkdir', 'rm', 'mv', 'ln', 'readlink', 'dirname']) {
    const command = (await execute('/bin/sh', ['-c', 'command -v "$1"', 'sh', name])).stdout.trim();
    await symlink(command, join(tools, name));
  }
  await rm(join(tools, 'uname'));
  await writeFile(join(tools, 'uname'), `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$FIXTURE_OS" ;;
  -m) printf '%s\\n' "$FIXTURE_ARCH" ;;
esac
`, { mode: 0o755 });
  const curlFixture = join(directory, 'curl.mjs');
  await writeFile(curlFixture, `import { copyFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2), url = args.at(-1);
await appendFile(process.env.FIXTURE_REQUESTS, url + '\\n');
if (!args.includes('=https')) throw new Error('HTTPS is required');
if (url.endsWith('/latest')) {
  process.stdout.write('https://github.com/stepandel/juiced/releases/tag/v0.2.0');
} else {
  if (process.env.FIXTURE_DOWNLOAD_ERROR === '1') process.exit(22);
  await copyFile(join(process.env.FIXTURE_ASSETS, url.split('/').at(-1)), args[args.indexOf('--output') + 1]);
}
`);
  await writeFile(join(tools, 'curl'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(curlFixture)} "$@"\n`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: tools, JUICED_INSTALL_DIR: install, JUICED_BIN_DIR: bin,
    FIXTURE_ASSETS: assets, FIXTURE_REQUESTS: join(directory, 'requests'),
    FIXTURE_COMPLETIONS: join(directory, 'completions'), JUICED_TELEMETRY_DISABLED: '1',
    FIXTURE_OS: process.platform === 'darwin' ? 'Darwin' : 'Linux', FIXTURE_ARCH: process.arch === 'arm64' ? 'arm64' : 'x86_64',
    JUICED_VERSION: 'latest', JUICED_CONFIG_HOME: join(directory, 'config'), JUICED_MODE: 'managed',
  };
  const asset = `juiced-${process.platform}-${process.arch}.tar.gz`;
  async function archive(version = '0.2.0', source) {
    if (source) {
      await copyFile(source, join(assets, asset));
    } else {
      const payload = join(directory, 'payload');
      await mkdir(join(payload, 'juiced/bin'), { recursive: true });
      await mkdir(join(payload, 'juiced/lib'), { recursive: true });
      await mkdir(join(payload, 'juiced/dist'), { recursive: true });
      await writeFile(join(payload, 'juiced/bin/juiced'), launcher, { mode: 0o755 });
      await writeFile(join(payload, 'juiced/lib/node'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
      // Match real archives: the launcher imports the bundled CLI under dist/.
      await writeFile(join(payload, 'juiced/bin/juiced.mjs'), '#!/bin/sh\nexec /bin/sh "$(dirname "$0")/../dist/cli.mjs" "$@"\n');
      await writeFile(join(payload, 'juiced/dist/cli.mjs'), `#!/bin/sh\ncase "$1" in\n--version) printf 'juiced ${version}\\n';;\n--help) printf 'juiced login\\n';;\n--internal-install-completed) printf '%s\\n' "$2" >> "$FIXTURE_COMPLETIONS";;\n*) printf '%s\\n' "$@";;\nesac\n`);
      await execute('tar', ['-czf', join(assets, asset), '-C', payload, 'juiced']);
    }
    const digest = createHash('sha256').update(await readFile(join(assets, asset))).digest('hex');
    await writeFile(join(assets, 'SHA256SUMS'), `${digest}  ${asset}\n`);
  }
  const run = (args = [], overrides = {}) => execute('/bin/sh', ['-c',
    // A real pipe ensures installation is noninteractive and receives arguments.
    `printf '%s' "$INSTALLER_SOURCE" | /bin/sh -s -- ${args.map(quote).join(' ')}`,
  ], { env: { ...env, INSTALLER_SOURCE: installer, ...overrides }, timeout: 30000 });
  const installed = args => execute(join(bin, 'juiced'), args, { env, timeout: 10000 });
  return { directory, assets, install, bin, env, asset, archive, run, installed };
}

test('piped installer resolves latest, verifies an archive and runs without Node/npm on PATH', async t => {
  const f = await fixture(t);
  await f.archive();
  assert.doesNotMatch((await readdir(f.env.PATH)).join('\n'), /^(node|npm)$/m);
  const result = await f.run();
  assert.match(result.stdout, /Installed Juiced 0\.2\.0/);
  assert.equal(await readFile(f.env.FIXTURE_COMPLETIONS, 'utf8'), 'fresh\n');
  assert.match(result.stdout, /Add .* to your PATH/);
  assert.equal((await f.installed(['--version'])).stdout.trim(), 'juiced 0.2.0');
  assert.equal((await f.installed(['prompt with spaces', "quote's"])).stdout, "prompt with spaces\nquote's\n");
  const requests = await readFile(f.env.FIXTURE_REQUESTS, 'utf8');
  assert.match(requests, /\/latest\n/);
  assert.match(requests, /\/download\/v0\.2\.0\/SHA256SUMS/);
  assert.match(requests, /\/download\/v0\.2\.0\/juiced-/);
  assert.ok((await readdir(join(f.install, 'releases'))).every(name => !name.startsWith('.install.')));
});

test('explicit version upgrades atomically and retains the previous runnable release', async t => {
  const f = await fixture(t);
  await f.archive();
  await f.run(['v0.2.0']);
  const previous = await readlink(join(f.bin, 'juiced'));
  assert.deepEqual((await readFile(resolve(previous, '../../install-paths'), 'utf8')).split('\0'), [f.install, f.bin, '']);
  await f.archive('0.2.1');
  await f.run(['0.2.1'], { JUICED_VERSION: 'invalid' });
  assert.equal(await readFile(f.env.FIXTURE_COMPLETIONS, 'utf8'), 'fresh\nupdate\n');
  assert.equal((await f.installed(['--version'])).stdout.trim(), 'juiced 0.2.1');
  assert.equal((await execute(previous, ['--version'], { env: f.env })).stdout.trim(), 'juiced 0.2.0');
  assert.doesNotMatch(await readFile(f.env.FIXTURE_REQUESTS, 'utf8'), /\/latest/);
  await f.run([], { JUICED_VERSION: '0.2.1' });
  assert.equal((await f.installed(['--version'])).stdout.trim(), 'juiced 0.2.1');
});

test('bad checksums and failed downloads preserve the installed command and clean staging files', async t => {
  const f = await fixture(t);
  await f.archive();
  await f.run(['0.2.0']);
  const previous = await readlink(join(f.bin, 'juiced'));
  await writeFile(join(f.assets, 'SHA256SUMS'), `${'0'.repeat(64)}  ${f.asset}\n`);
  await assert.rejects(f.run(['0.2.1']), error => /checksum did not match/.test(error.stderr));
  await assert.rejects(f.run(['0.2.1'], { FIXTURE_DOWNLOAD_ERROR: '1' }), error => /Could not download/.test(error.stderr));
  await f.archive('0.2.0');
  await assert.rejects(f.run(['0.2.1']), error => /version does not match/.test(error.stderr));
  assert.equal(await readlink(join(f.bin, 'juiced')), previous);
  assert.equal((await f.installed(['--version'])).stdout.trim(), 'juiced 0.2.0');
  assert.equal((await readdir(join(f.install, 'releases'))).length, 1);
  assert.equal(await readFile(f.env.FIXTURE_COMPLETIONS, 'utf8'), 'fresh\n');
});

test('installer also verifies downloads using sha256sum when available', async t => {
  const f = await fixture(t);
  await f.archive();
  await writeFile(join(f.env.PATH, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  await f.run(['0.2.0']);
  assert.equal((await f.installed(['--version'])).stdout.trim(), 'juiced 0.2.0');
});

test('release candidates install only when their version is selected explicitly', async t => {
  const f = await fixture(t);
  await f.archive('0.2.0-rc.1');
  await f.run(['v0.2.0-rc.1']);
  assert.equal((await f.installed(['--version'])).stdout.trim(), 'juiced 0.2.0-rc.1');
  assert.doesNotMatch(await readFile(f.env.FIXTURE_REQUESTS, 'utf8'), /\/latest/);
});

test('unsupported hosts, invalid versions and existing unrelated commands fail clearly', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([], { FIXTURE_OS: 'Windows_NT' }), error => /Supported systems/.test(error.stderr));
  await assert.rejects(f.run([], { FIXTURE_ARCH: 'riscv64' }), error => /Supported architectures/.test(error.stderr));
  await assert.rejects(f.run(['../../other']), error => /Expected a release version/.test(error.stderr));
  await assert.rejects(f.run(['0.2.0\n../../other']), error => /Expected a release version/.test(error.stderr));
  await assert.rejects(f.run(['0.2.0'], { JUICED_INSTALL_DIR: 'relative' }), error => /absolute path/.test(error.stderr));
  await mkdir(f.bin);
  await writeFile(join(f.bin, 'juiced'), 'existing command');
  await assert.rejects(f.run(['0.2.0']), error => /existing command occupies/.test(error.stderr));
  assert.equal(await readFile(join(f.bin, 'juiced'), 'utf8'), 'existing command');
});

test('missing checksum entries and an unrunnable payload never activate a release', async t => {
  const f = await fixture(t);
  await f.archive();
  await writeFile(join(f.assets, 'SHA256SUMS'), `${'0'.repeat(64)}  other.tar.gz\n`);
  await assert.rejects(f.run(['0.2.0']), error => /Missing or invalid release checksum/.test(error.stderr));
  await f.archive();
  await writeFile(join(f.directory, 'payload/juiced/lib/node'), '#!/bin/sh\nexit 1\n');
  await execute('tar', ['-czf', join(f.assets, f.asset), '-C', join(f.directory, 'payload'), 'juiced']);
  const digest = createHash('sha256').update(await readFile(join(f.assets, f.asset))).digest('hex');
  await writeFile(join(f.assets, 'SHA256SUMS'), `${digest}  ${f.asset}\n`);
  await assert.rejects(f.run(['0.2.0']), error => /cannot run on this system/.test(error.stderr));
  await assert.rejects(readlink(join(f.bin, 'juiced')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(f.install, 'releases')), []);
});

if (actualArchive) test('real release archive installs and runs offline with Node/npm absent from PATH', async t => {
  const f = await fixture(t);
  await f.archive(packageVersion, actualArchive);
  await f.run([packageVersion]);
  assert.equal((await f.installed(['--version'])).stdout.trim(), `juiced ${packageVersion}`);
  assert.match((await f.installed(['--help'])).stdout, /login/);
  const entry = await readlink(join(f.bin, 'juiced'));
  const root = resolve(entry, '../..');
  assert.equal(JSON.parse(await readFile(join(root, 'release.json'))).version, packageVersion);
  assert.ok((await readFile(join(root, 'lib/NODE_LICENSE'))).length > 1000);
  await assert.rejects(readFile(join(root, 'service/package.json')));
  await assert.rejects(readFile(join(root, 'node_modules/stripe/package.json')));
});
