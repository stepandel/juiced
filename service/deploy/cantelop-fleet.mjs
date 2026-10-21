// Creates or reuses the Juiced Fleet, issues its API and worker principals,
// and registers a Juiced App release as the approved package. Uses the owner
// credential from `cantelop login`. Prints NAME=value lines for
// production-env.sh; never run it with stdout attached to a terminal.
//
//   node cantelop-fleet.mjs RELEASE_ID VERSION EXPECTED_RUNTIME_ID
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [releaseId, version, expectedRuntime] = process.argv.slice(2);
if (!/^rel_[a-f0-9]{32}$/.test(releaseId ?? '') || !version || !expectedRuntime)
  throw new Error('Usage: cantelop-fleet.mjs RELEASE_ID VERSION EXPECTED_RUNTIME_ID');
if (process.stdout.isTTY || process.env.JUICED_FLEET_SETUP !== '1')
  throw new Error('Run through service/deploy/production-env.sh cantelop');

const api = process.env.CANTELOP_API_URL ?? 'https://cantelop.com';
const name = process.env.FLEET_NAME ?? 'juiced';
const maxApps = Number(process.env.FLEET_MAX_APPS ?? 25);
const expiresAt = new Date(Date.now() + 180 * 86400000).toISOString();
const configPath =
  process.env.CANTELOP_CONFIG ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/cantelop/config.json')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cantelop/config.json'));
const refresh = JSON.parse(await readFile(configPath, 'utf8')).refresh_token;
if (!refresh) throw new Error('Run `cantelop login` first');

const log = (line) => process.stderr.write(`  ${line}\n`);
async function call(method, path, token, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${value.error ?? ''}`);
  return value;
}
// Owner access tokens live for 60 seconds, so each owner call gets a fresh one.
async function owner(method, path, body) {
  const issued = await fetch(`${api}/api/cli/token`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!issued.ok) throw new Error(`Cantelop login expired (${issued.status}); run \`cantelop login\``);
  return call(method, path, (await issued.json()).access_token, body);
}

let fleet = (await owner('GET', '/v1/fleets')).items.find((f) => f.name === name);
if (fleet) log(`reusing Fleet ${fleet.id}`);
else {
  fleet = await owner('POST', '/v1/fleets', { name, maxApps });
  log(`created Fleet ${fleet.id} (max ${maxApps} Apps)`);
}
const principal = async (label, scopes) => {
  const p = await owner('POST', `/v1/fleets/${fleet.id}/principals`, { label, scopes, expiresAt });
  log(`issued ${label} principal ${p.id}, expires ${p.expiresAt}`);
  return p;
};
const revoke = (p) => owner('DELETE', `/v1/fleets/${fleet.id}/principals/${p.id}`);

const publisher = await principal('juiced-publisher', ['packages:write', 'installations:read']);
let pkg;
try {
  pkg = await call('POST', `/v1/fleets/${fleet.id}/packages`, publisher.token, {
    releaseId,
    version,
  });
  if (pkg.runtime_id !== expectedRuntime) {
    await call('DELETE', `/v1/fleets/${fleet.id}/packages/${pkg.id}`, publisher.token);
    throw new Error(
      `${releaseId} has runtime ${pkg.runtime_id}, but this CLI build expects ${expectedRuntime}; ` +
        'deploy the App with `cantelop deploy` and use the new release',
    );
  }
  log(`registered package ${pkg.id} (${pkg.name} ${pkg.version})`);
} finally {
  // Packages are published once; a later release issues a new publisher.
  await revoke(publisher);
}
const apiPrincipal = await principal('juiced-api', ['installations:read', 'credentials:read']);
const worker = await principal('juiced-worker', [
  'installations:read',
  'installations:write',
  'credentials:read',
  'policy:write',
  'usage:read',
]);
process.stdout.write(
  [
    `CANTELOP_FLEET_ID=${fleet.id}`,
    `CANTELOP_FLEET_TOKEN=${apiPrincipal.token}`,
    `CANTELOP_WORKER_FLEET_TOKEN=${worker.token}`,
    `JUICED_PACKAGE_ID=${pkg.id}`,
    `JUICED_RUNTIME_ID=${pkg.runtime_id}`,
    '',
  ].join('\n'),
);
