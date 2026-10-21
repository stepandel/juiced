import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import type { AppCommandEnvelope } from '@cantelop/sdk';
import type { TerminalCommand, TerminalEvent } from '../src/protocol.js';
import { createTerminal } from '../src/runtime/terminal.js';

// Exercise the real CLI, SDK transport, and runtime with a local platform fixture.
// Any sync request fails: only workspace binding, authentication and terminal operations are served.
test('non-Git launches keep local and remote files separate across sessions and exit', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-isolation-')));
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
  const buildDirectory = await mkdtemp(join(projectRoot, '.cantelop', 'isolation-'));
  const local = join(root, 'project'), remote = join(root, 'workspace');
  const lifetime = new AbortController();
  const histories = new Map<string, TerminalEvent[]>(), emitted = new EventEmitter();
  const terminals = new Map<string, ReturnType<typeof createTerminal>>();
  const tasks: Promise<unknown>[] = [], routes: string[] = [], failures: unknown[] = [];
  let origin: string;
  const server = createServer(async (request, response) => {
    const connection = new AbortController(); response.once('close', () => connection.abort());
    try {
      routes.push(request.url!);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as AppCommandEnvelope<TerminalCommand>;
      const operation = body.command;
      assert.equal(request.url, `/commands/${operation.type}`);
      assert.equal(request.headers.authorization, 'Bearer fixture-token');
      const reply = (value: object) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ protocolVersion: 2, id: body.id, ...value })); };
      if (operation.type === 'workspace.resolve') {
        assert.deepEqual(body.workspace, { slug: 'isolation' });
        reply({ id: `wsp_${'3'.repeat(32)}`, app_id: `app_${'4'.repeat(32)}`, slug: 'isolation', hostname: 'fixture.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' });
        return;
      }
      assert.deepEqual(body.workspace, { id: `wsp_${'3'.repeat(32)}` });
      assert.ok(body.session);
      const session = body.session.id;
      if (operation.type === 'auth') { reply({ reply: { type: 'status', authenticated: true } }); return; }
      if (operation.type === 'stop') { terminals.get(session)?.cancel(); reply({}); return; }
      if (operation.type === 'request') {
        const command = operation.message;
        if (command.type === 'start') {
          assert.equal(command.directoryName, 'project');
          const terminal = createTerminal({ signal: lifetime.signal, session: { id: session, keepAliveSeconds: 120 }, env: {}, database: async () => { throw new Error('unused'); } }, { workspace: remote, binary: process.execPath });
          terminals.set(session, terminal); histories.set(session, []);
          tasks.push(terminal.run(command, { signal: lifetime.signal, output: { async send(event) { histories.get(session)!.push(event); emitted.emit(session); } } }).catch(error => { failures.push(error); }));
          reply({ reply: { ok: true } });
        } else reply({ reply: await terminals.get(session)!.input(command) });
        return;
      }
      assert.equal(operation.type, 'stream', 'Automatic sync must never be requested');
      if (operation.type !== 'stream') throw new Error('Unexpected command');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let index = operation.after?.sequence ?? 0;
      while (!connection.signal.aborted) {
        while (!histories.get(session)?.[index]) await once(emitted, session, { signal: connection.signal });
        const data = histories.get(session)![index++]!;
        response.write(`id: ${'a'.repeat(32)}:${index}\ndata: ${JSON.stringify({ stream_id: 'a'.repeat(32), sequence: index, session_id: session, message_id: body.id, created_at: new Date().toISOString(), data })}\n\n`);
        if (data.type === 'exit') break;
      }
      response.end();
    } catch (error) {
      if (!connection.signal.aborted) failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  t.after(async () => {
    lifetime.abort(); for (const terminal of terminals.values()) terminal.cancel();
    await Promise.all(tasks); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(buildDirectory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  await mkdir(local); await mkdir(remote); await writeFile(join(local, 'README.md'), 'local only');
  await build({ entryPoints: [join(projectRoot, 'src/cli.ts')], bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
    plugins: [createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })], outfile: join(buildDirectory, 'cli.mjs') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  const run = async () => {
    const child = spawn(process.execPath, [join(buildDirectory, 'cli.mjs'), 'claude', '-e', `
      const fs = require('node:fs');
      process.stdin.resume(); process.stdin.once('end', () => {
        console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, files: fs.readdirSync('.') }));
        fs.writeFileSync('agent.txt', 'remote only');
      });
    `], { cwd: local, env: { ...process.env, HOME: root, JUICED_WORKSPACE: 'isolation', CANTELOP_APP_SLUG: 'juiced', CANTELOP_INTEGRATION_TOKEN: 'fixture-token', CANTELOP_EDGE_URL: origin }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdin.end();
    try { const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); return JSON.parse(stdout); }
    finally { clearTimeout(timeout); }
  };
  assert.deepEqual(await run(), { cwd: join(remote, 'project'), home: remote, files: [] });
  await writeFile(join(local, 'README.md'), 'later local edit');
  assert.deepEqual(await run(), { cwd: join(remote, 'project'), home: remote, files: ['agent.txt'] });
  assert.deepEqual(await readdir(local), ['README.md']);
  assert.equal(await readFile(join(local, 'README.md'), 'utf8'), 'later local edit');
  assert.equal(await readFile(join(remote, 'project', 'agent.txt'), 'utf8'), 'remote only');
  assert.equal(routes.some(route => /sync/.test(route)), false);
  assert.equal(routes.filter(route => route === '/commands/workspace.resolve').length, 2, 'Each CLI launch resolves only once; every session operation uses the ID');
  assert.deepEqual(failures, []);
});
