import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Disposable account service boundary for CLI integration probes.
export async function accountFixtureEnv(root, origin) {
  const config = join(root, 'account-config');
  await mkdir(join(config, 'credentials'), { recursive: true, mode: 0o700 });
  await writeFile(join(config, 'credentials', createHash('sha256').update(origin).digest('hex') + '.json'), JSON.stringify({
    origin, accessToken: 'fixture-account-token-0123456789', refreshToken: 'fixture-refresh-token-0123456789',
    expiresAt: Date.now() + 300000, account: 'acc_' + 'a'.repeat(32),
  }), { mode: 0o600 });
  return { JUICED_CONFIG_HOME: config, JUICED_SERVICE_URL: origin, JUICED_ALLOW_LOCAL: '1', JUICED_TELEMETRY_DISABLED: '1' };
}
export async function handleAccountFixture(request, response, edgeToken) {
  if (request.url.endsWith('/installation')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'jin_' + 'a'.repeat(32), status: 'ready', runtimeId: 'fixture.v1', minimumCli: '0.2.0', error: null, operationId: 'fixture' }));
    return true;
  }
  if (request.url.endsWith('/bootstrap')) {
    const bytes = []; for await (const chunk of request) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'jin_' + 'a'.repeat(32), status: 'ready', runtimeId: body.runtimeId,
      minimumCli: '0.2.0', error: null, operationId: 'fixture' }));
    return true;
  }
  const prefix = '/v1/accounts/acc_' + 'a'.repeat(32) + '/runtime';
  if (!request.url.startsWith(prefix) || request.headers.authorization !== 'Bearer fixture-account-token-0123456789') {
    response.writeHead(401); response.end(); return true;
  }
  request.url = request.url.slice(prefix.length);
  request.headers.authorization = 'Bearer ' + edgeToken;
  return false;
}
