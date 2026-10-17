import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Uses one signed-in Workspace, real Claude, and one disposable project folder.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.cantelop'), { recursive: true });
const buildDirectory = await mkdtemp(join(root, '.cantelop', 'sync-live-'));
const local = await mkdtemp(join(tmpdir(), 'juiced-sync-live-'));
const token = `JUICED_SYNC_${randomUUID().replaceAll('-', '')}`;
let agent, sync;
try {
  await build({ stdin: { contents: "export { app } from './src/cantelop.ts'; export { RemoteAgent } from './src/remote-agent.ts';", resolveDir: root, sourcefile: 'sync-live.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', plugins: [createCantelopCompilerPlugin({ definition: join(root, 'src/cantelop.ts') })], outfile: join(buildDirectory, 'app.mjs') });
  const { app, RemoteAgent } = await import(pathToFileURL(join(buildDirectory, 'app.mjs')).href);
  const directoryName = local.split('/').at(-1);
  const workspace = app.workspace({ slug: process.env.JUICED_WORKSPACE ?? 'default' });
  await writeFile(join(local, 'README.md'), token + '\n');
  await writeFile(join(local, '.env'), 'excluded live-test fixture');
  sync = await workspace.sync({ localDirectory: local, remoteDirectory: directoryName });
  await sync.ready(); assert.equal(sync.status().writable, true);
  agent = new RemoteAgent(workspace.session({ keepAliveSeconds: 120 }), { directoryName, beforeSubmit: () => sync.flush() });
  let approvals = 0, permissionFailure;
  agent.on('approvals', () => {
    for (const approval of agent.approvals.values()) {
      const write = approval.tool === 'Write' && approval.input.file_path === posix.join(sync.remoteDirectory, 'agent.txt') && approval.input.content?.trim() === token;
      const read = approval.tool === 'Read' && approval.input.file_path === posix.join(sync.remoteDirectory, 'README.md');
      const expected = read || write;
      if (!expected) permissionFailure = new Error(`Unexpected live-test permission request: ${approval.tool}`);
      if (write) approvals++;
      void agent.answer(approval.id, expected).catch(error => { permissionFailure = error; });
    }
  });
  await agent.start();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Live project sync turn timed out')), 180_000);
    const frame = value => { if (value.type === 'result') finish(undefined, value); };
    const failed = error => finish(error);
    function finish(error, value) { clearTimeout(timer); agent.off('frame', frame); agent.off('failure', failed); error ? reject(error) : resolve(value); }
    agent.on('frame', frame).once('failure', failed);
  });
  await agent.submit('Use Read to read README.md in your current directory. Use Write once to create agent.txt in this directory with exactly the token from README.md. Reply with exactly that token and nothing else. Use no other tools.');
  const answer = await result;
  if (permissionFailure) throw permissionFailure;
  assert.equal(answer.is_error, false); assert.equal(answer.result.trim(), token); assert.equal(approvals, 1);
  await sync.flush(); assert.equal((await readFile(join(local, 'agent.txt'), 'utf8')).trim(), token);
  console.log('PASS: local README upload, remote project cwd, explicit Write approval, streamed reply, and agent edit downloaded locally.');
  await agent.close();
  await rm(join(local, 'README.md')); await rm(join(local, 'agent.txt')); await sync.flush();
  console.log('PASS: synchronized cleanup of both remote fixture files.');
} finally {
  try { await agent?.close(); } finally {
    await sync?.stop(); await rm(local, { recursive: true, force: true }); await rm(buildDirectory, { recursive: true, force: true });
  }
}
