import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Real remote headless Claude, persistent conversation, and explicit Write approval.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.cantelop'), { recursive: true });
const temporary = await mkdtemp(join(root, '.cantelop', 'agent-live-'));
let agent;
try {
  await build({ stdin: { contents: `export { app } from './src/cantelop.ts'; export { RemoteAgent } from './src/remote-agent.ts'; export { emptyConversation, userTurn, receiveFrame } from './src/tui/conversation.ts';`, resolveDir: root, sourcefile: 'live-agent.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', plugins: [createCantelopCompilerPlugin({ definition: join(root, 'src/cantelop.ts') })], outfile: join(temporary, 'app.mjs') });
  const { app, RemoteAgent, emptyConversation, userTurn, receiveFrame } = await import(pathToFileURL(join(temporary, 'app.mjs')).href);
  const resolved = await app.workspace({ slug: process.env.JUICED_WORKSPACE ?? 'default' }).resolve();
  agent = new RemoteAgent(app.workspace({ id: resolved.id }).session({ keepAliveSeconds: 120 }));
  let view = emptyConversation();
  agent.on('frame', frame => { view = receiveFrame(view, frame); });
  const token = `JUICED_TUI_${randomUUID().replaceAll('-', '')}`;
  const file = `/workspace/.juiced-smoke-${randomUUID()}.txt`;
  const cleanup = `test "$(cat '${file}')" = '${token}' && rm -- '${file}'`;
  let approvals = 0;
  let denied = false;
  let permissionFailure;
  agent.on('approvals', () => {
    for (const approval of agent.approvals.values()) {
      const write = approval.tool === 'Write' && approval.input.file_path === file;
      const expected = write || approval.tool === 'Bash' && approval.input.command === cleanup;
      if (!expected) permissionFailure = new Error(`Unexpected permission request: ${approval.tool}`);
      approvals++;
      // First Write is denied; the next explicitly requested turn is allowed.
      const allow = expected && denied;
      if (write) denied = true;
      void agent.answer(approval.id, allow).catch(error => { permissionFailure = error; });
    }
  });
  async function turn(text, interrupt = false) {
    view = userTurn(view, text);
    let interrupted = false;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Live Claude turn timed out')), 120_000);
      const frame = value => {
        if (interrupt && !interrupted && value.type === 'stream_event' && value.event?.delta?.type === 'text_delta') {
          interrupted = true;
          void agent.interrupt().catch(error => finish(error));
        }
        if (value.type === 'result') finish(undefined, value);
      };
      const failed = error => finish(error);
      function finish(error, value) { clearTimeout(timer); agent.off('frame', frame); agent.off('failure', failed); error ? reject(error) : resolve(value); }
      agent.on('frame', frame).once('failure', failed);
    });
    await agent.submit(text);
    const value = await result;
    if (permissionFailure) throw permissionFailure;
    if (!interrupt) assert.equal(value.is_error, false, JSON.stringify(value));
    return value;
  }
  await agent.start();
  console.log('Headless Claude handshake passed.');
  const first = await turn(`Remember the token ${token}. Reply with exactly that token and nothing else. Do not use tools.`);
  assert.equal(first.result.trim(), token);
  const second = await turn('Reply with exactly the token from my previous message. Do not use tools.');
  assert.equal(second.result.trim(), token);
  console.log('Two turns passed in the same remote Claude process.');
  await turn(`Use the Write tool once to create ${file} containing exactly ${token}. If I decline permission, stop and reply DECLINED. Do not use other tools or retry.`);
  assert.equal(approvals, 1, 'Write must request approval');
  await turn(`I now want to allow it. Use the Write tool once to create ${file} containing exactly ${token}. Do not use other tools. Then reply SAVED.`);
  assert.equal(approvals, 2, 'The second Write must request fresh approval');
  const cleaned = await turn(`Use Bash to run exactly this command to verify and remove the smoke-test file: ${cleanup}\nDo not use other tools or change the command. If it succeeds reply exactly CLEANED.`);
  assert.equal(cleaned.result.trim(), 'CLEANED');
  console.log('Permission denial, allow-once, remote file verification and cleanup passed.');
  const cancelled = await turn('Write the numbers 1 through 1000, one per line. Do not use tools. This is a streaming interruption test.', true);
  assert.equal(cancelled.juiced_interrupted, true);
  assert.ok(view.history.at(-1).entries.filter(entry => entry.kind === 'text').length <= 1, 'Interrupted output should not be duplicated');
  assert.equal(view.history.at(-1).entries.at(-1).text, 'Interrupted');
  const after = await turn('Reply with exactly AFTER_INTERRUPT_OK. Do not use tools.');
  assert.equal(after.result.trim(), 'AFTER_INTERRUPT_OK');
  console.log('Streaming interruption and the following turn passed.');
} finally {
  try { await agent?.close(); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
