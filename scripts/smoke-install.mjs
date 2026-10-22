import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const execute = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'juiced-install-'));
const { version: packageVersion, dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sdkVersion = dependencies['@cantelop/sdk'];
let server;
try {
  const env = {
    ...process.env,
    JUICED_MODE: 'managed',
    JUICED_CONFIG_HOME: join(directory, 'config'),
  };
  for (const key of Object.keys(env))
    if (key.startsWith('CANTELOP_') || key === 'JUICED_SERVICE_URL' || key === 'JUICED_ALLOW_LOCAL')
      delete env[key];
  if (process.env.CANTELOP_SDK_TARBALL) {
    const sdk = await readFile(resolve(process.env.CANTELOP_SDK_TARBALL));
    server = createServer((request, response) => {
      if (request.url?.includes('.tgz')) {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(sdk);
        return;
      }
      const origin = `http://127.0.0.1:${server.address().port}`;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          name: '@cantelop/sdk',
          'dist-tags': { latest: sdkVersion },
          versions: {
            [sdkVersion]: {
              name: '@cantelop/sdk',
              version: sdkVersion,
              type: 'module',
              dependencies: {
                '@libsql/client': '^0.17.0',
                'drizzle-kit': '0.31.10',
                'drizzle-orm': '0.45.2',
                esbuild: '^0.25.0',
                typescript: '^5.9.3',
              },
              dist: { tarball: `${origin}/sdk-${sdkVersion}.tgz` },
            },
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env.npm_config_registry = 'https://registry.npmjs.org';
    // Route only the unreleased SDK through the local fixture. All other
    // packages retain their ordinary registry identity and integrity checks.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(directory, '.npmrc'),
      `@cantelop:registry=http://127.0.0.1:${server.address().port}\n`,
    );
  }
  const packed = JSON.parse(
    (
      await execute(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
        { env, timeout: 60000, maxBuffer: 2 ** 20 },
      )
    ).stdout,
  )[0];
  assert.ok(packed.files.some((f) => f.path === 'dist/cli.mjs'));
  assert.ok(
    packed.files.every((f) => !/^service\/|^src\/|\.env|node_modules/.test(f.path)),
    'private service/source must stay out of npm package',
  );
  await execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      directory,
      join(directory, packed.filename),
    ],
    { cwd: directory, env, timeout: 180000, maxBuffer: 2 ** 20 },
  );
  const bin = join(directory, 'node_modules', 'juiced', 'bin', 'juiced.mjs');
  const version = await execute(process.execPath, [bin, '--version'], {
    cwd: directory,
    env,
    timeout: 10000,
  });
  assert.equal(version.stdout.trim(), `juiced ${packageVersion}`);
  const help = await execute(process.execPath, [bin, '--help'], {
    cwd: directory,
    env,
    timeout: 10000,
  });
  assert.match(help.stdout, /login/);
  process.stdout.write(
    'Fresh package install, offline help/version, and private-file exclusion passed.\n',
  );
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
