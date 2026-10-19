import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'juiced-env-cli-'));
const calls = [];
let polls = 0;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, 'Bearer fixture-app-token');
    const chunks = []; for await (const bytes of request) chunks.push(bytes);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.url, `/commands/${body.command.type}`);
    assert.equal(body.workspace, null); assert.equal(body.session, null);
    calls.push(body.command);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ protocolVersion: 2, id: body.id, revision: 3, status: body.command.type === 'app.environment.status' && ++polls > 1 ? 'applied' : 'pending' }));
  } catch { response.writeHead(500); response.end(); }
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.mjs', import.meta.url)), 'env', 'set', 'GH_TOKEN', '--stdin'], {
    cwd: directory, env: { PATH: '', HOME: directory, CANTELOP_APP_SLUG: 'juiced', CANTELOP_INTEGRATION_TOKEN: 'fixture-app-token', CANTELOP_EDGE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
  child.stdin.end('fixture-gh-token\n');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const [code] = await once(child, 'close'); clearTimeout(timeout);
  assert.equal(code, 0, output);
  assert.deepEqual(calls[0], { type: 'app.environment.set', name: 'GH_TOKEN', value: 'fixture-gh-token', secret: true });
  assert.equal(calls.length, 3); assert.match(output, /Set GH_TOKEN/); assert.doesNotMatch(output, /fixture-gh-token/);
  console.log('PASS: installed CLI sets a secret through the SDK, waits for propagation, and works with an empty PATH and no Cantelop CLI or login.');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
