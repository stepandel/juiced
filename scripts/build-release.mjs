import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nodeDistribution } from './node-distribution.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, 'dist/releases'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const runtimeId = JSON.parse(await readFile(join(root, 'dist/cantelop/backend/cantelop-client.json'), 'utf8'))
  .apps.find(app => app.name === 'juiced').session_runtime_id;
assert.match(runtimeId, /^rt_[a-f0-9]{64}$/, 'Run npm run build:runtime before packaging');
assert.match(manifest.dependencies['@cantelop/sdk'], /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Publish Juiced only after replacing the draft SDK Git pin with its released npm version');
const { platform, arch } = process;
assert.ok(['darwin', 'linux'].includes(platform) && ['arm64', 'x64'].includes(arch));
assert.ok(/^\d+\.\d+\.\d+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/.test(manifest.version));
if (process.env.GITHUB_REF_TYPE === 'tag')
  assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'Tag must match package.json');

const temporary = await mkdtemp(join(tmpdir(), 'juiced-release-'));
try {
  await mkdir(output, { recursive: true });
  const packed = JSON.parse((await execute('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
  ], { cwd: root, timeout: 60000 })).stdout)[0];
  assert.ok(packed.files.some(file => file.path === 'dist/cli.mjs'), 'Run npm run build first');
  const bundle = join(temporary, 'juiced');
  await mkdir(bundle);
  await execute('tar', ['-xzf', join(temporary, packed.filename), '--strip-components=1', '-C', bundle], { timeout: 60000 });
  // Preserve the committed dependency versions and integrity hashes, without the
  // service workspace, development tools, or package lifecycle scripts.
  for (const value of [manifest, lock.packages['']]) {
    delete value.workspaces;
    delete value.devDependencies;
    delete value.scripts;
  }
  await writeFile(join(bundle, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(bundle, 'package-lock.json'), JSON.stringify(lock));
  process.stdout.write('Installing locked CLI dependencies...\n');
  await execute('npm', ['ci', '--omit=dev', '--ignore-scripts', '--workspaces=false', '--no-audit', '--no-fund'], {
    cwd: bundle, timeout: 180000, maxBuffer: 2 ** 20,
  });
  // npm must not retain the private workspace or its account-service packages.
  await assert.rejects(readFile(join(bundle, 'node_modules/@juiced/service/package.json')));
  await assert.rejects(readFile(join(bundle, 'node_modules/stripe/package.json')));
  await rm(join(bundle, 'package-lock.json'));
  // npm includes README automatically; it describes the source checkout rather
  // than the installed layout. Keep licenses, but exclude that development guide.
  await rm(join(bundle, 'README.md'), { force: true });

  // Use the official portable Node distribution, not a potentially dynamically
  // linked Homebrew/system Node executable from the build host.
  const nodeVersion = process.versions.node;
  const nodeArchive = `node-v${nodeVersion}-${platform}-${arch}.tar.gz`;
  const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`;
  process.stdout.write(`Downloading official Node ${nodeVersion} for ${platform}/${arch}...\n`);
  const download = async name => {
    const response = await fetch(`${nodeBase}/${name}`, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `Cannot download Node ${name}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const nodeBytes = await nodeDistribution(nodeArchive, download, process.env.JUICED_NODE_CACHE);
  await writeFile(join(temporary, nodeArchive), nodeBytes);
  const runtime = join(temporary, 'runtime');
  await mkdir(runtime);
  await execute('tar', ['-xzf', join(temporary, nodeArchive), '--strip-components=1', '-C', runtime], { timeout: 60000 });
  await mkdir(join(bundle, 'lib'));
  await copyFile(join(runtime, 'bin/node'), join(bundle, 'lib/node'));
  await chmod(join(bundle, 'lib/node'), 0o755);
  await copyFile(join(runtime, 'LICENSE'), join(bundle, 'lib/NODE_LICENSE'));
  await copyFile(join(root, 'scripts/release-launcher.sh'), join(bundle, 'bin/juiced'));
  await chmod(join(bundle, 'bin/juiced'), 0o755);
  await writeFile(join(bundle, 'release.json'), JSON.stringify({
    version: manifest.version, nodeVersion, platform, arch,
    commit: (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 30000 })).stdout.trim(),
    sourceClean: !(await execute('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, timeout: 30000 })).stdout.trim(),
    runtimeId,
  }) + '\n');

  const env = { ...process.env, JUICED_CONFIG_HOME: join(temporary, 'config') };
  const version = await execute(join(bundle, 'bin/juiced'), ['--version'], { env, timeout: 15000 });
  assert.equal(version.stdout.trim(), `juiced ${manifest.version}`);
  const help = await execute(join(bundle, 'bin/juiced'), ['--help'], { env, timeout: 15000 });
  assert.match(help.stdout, /login/);
  const asset = `juiced-${platform}-${arch}.tar.gz`;
  await execute('tar', ['-czf', join(output, asset), '-C', temporary, 'juiced'], { timeout: 120000 });
  const digest = createHash('sha256').update(await readFile(join(output, asset))).digest('hex');
  await writeFile(join(output, `${asset}.sha256`), `${digest}  ${asset}\n`);
  process.stdout.write(`Built ${asset} with Node ${nodeVersion}; offline help/version passed.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
