import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';

// Only exact Bash commands against this run's disposable repository are approved.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.cantelop'), { recursive: true });
const buildDirectory = await mkdtemp(join(root, '.cantelop', 'git-live-'));
const local = await mkdtemp(join(tmpdir(), 'juiced-git-live-'));
const token = `JUICED_GIT_${randomUUID().replaceAll('-', '')}`;
let client, first, second, runTurn, cleanupCommand;
let cleaned = false;
const report = { date: new Date().toISOString(), checks: [] };
const passed = message => { console.log(`PASS: ${message}`); report.checks.push(message); };
try {
  await build({ stdin: { contents: "export { app } from './src/cantelop.ts'; export { RemoteAgent } from './src/remote-agent.ts'; export { GitWorkspaceClient } from './src/git-workspace.ts'; export { selectProject } from './src/project.ts'; export { discoverRepository, git, gitText } from './src/git.ts';", resolveDir: root, sourcefile: 'git-live.ts', loader: 'ts' }, bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', plugins: [createCantelopCompilerPlugin({ definition: join(root, 'src/cantelop.ts') })], outfile: join(buildDirectory, 'app.mjs') });
  const { app, RemoteAgent, GitWorkspaceClient, selectProject, discoverRepository, git, gitText } = await import(pathToFileURL(join(buildDirectory, 'app.mjs')).href);
  await git(local, ['init', '-b', 'main']);
  await git(local, ['config', 'user.name', 'Juiced live test']); await git(local, ['config', 'user.email', 'juiced-live@localhost']);
  await writeFile(join(local, 'README.md'), 'base\n'); await git(local, ['add', '.']); await git(local, ['commit', '-m', 'local unpublished base']);
  const base = await gitText(local, ['rev-parse', 'HEAD']);
  await writeFile(join(local, 'README.md'), token + '\n'); await git(local, ['add', 'README.md']);
  const indexBefore = await readFile(join(local, '.git', 'index'));
  const project = await selectProject(local, process.env.JUICED_WORKSPACE ?? 'default');
  console.log(`Disposable Git project: ${project.remoteDirectory} (workspace ${project.workspace})`);
  cleanupCommand = `cd /workspace && rm -rf -- '${project.directoryName}' '.juiced/${project.directoryName}'`;
  const repository = await discoverRepository(local);
  const workspace = app.workspace({ slug: project.workspace });
  client = new GitWorkspaceClient(workspace, project, repository, AbortSignal.timeout(10 * 60_000));
  const started = Date.now(); await client.send(true);
  report.initialTransferMs = Date.now() - started;
  assert.equal((await client.status()).head, base);
  assert.deepEqual(await readFile(join(local, '.git', 'index')), indexBefore);
  passed('unpublished HEAD and staged snapshot transferred without changing the local index');
  const options = { directoryName: project.directoryName, git: { binding: repository.binding, relativeDirectory: repository.relativeDirectory } };
  first = new RemoteAgent(workspace.session({ keepAliveSeconds: 120 }), options);
  second = new RemoteAgent(workspace.session({ keepAliveSeconds: 120 }), options);
  const approved = new Map();
  const approvals = agent => agent.on('approvals', () => {
    for (const approval of agent.approvals.values()) void agent.answer(approval.id, approval.tool === 'Bash' && approval.input.command === approved.get(agent)).catch(error => { console.error(error.message); });
  });
  approvals(first); approvals(second);
  runTurn = async (agent, command) => {
    approved.set(agent, command);
    let finish;
    const result = new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => finish(new Error('Live Git turn timed out')), 180_000);
      const frame = value => { if (value.type === 'result') finish(undefined, value); };
      const failure = error => finish(error);
      finish = (error, value) => { clearTimeout(timer); agent.off('frame', frame); agent.off('failure', failure); error ? reject(error) : resolveResult(value); };
      agent.on('frame', frame).once('failure', failure);
    });
    try { await agent.submit(`Use Bash exactly once to run this exact command in your current directory:\n${command}\nDo not use any other tools or modify the command. Report its output.`); }
    catch (error) { finish(error); }
    const answer = await result; assert.equal(answer.is_error, false, JSON.stringify(answer));
    return answer;
  };
  await first.start(['--tools', 'Bash']); await second.start(['--tools', 'Bash']);
  passed('two separate Claude sessions attached to the same Git checkout');
  await assert.rejects(client.send(false), /checkout is in use/);
  passed('outbound checkout replacement refused while sessions were active');
  const shared = await runTurn(second, 'git rev-parse --verify HEAD && cat README.md');
  assert.ok(shared.result.includes(base)); assert.ok(shared.result.includes(token));
  await runTurn(first, `printf '%s\\n' '${token}' > agent.txt && git add README.md agent.txt && git commit -m 'live agent result'`);
  const imported = await client.receive();
  assert.notEqual(imported.head, base);
  assert.equal(await gitText(local, ['rev-parse', 'HEAD']), base);
  assert.deepEqual(await readFile(join(local, '.git', 'index')), indexBefore);
  passed('remote commit imported with its original identity while local HEAD and snapshot stayed unchanged');
  await assert.rejects(client.fastForward(), /local checkout must be clean/);
  await git(local, ['restore', '--staged', '--worktree', 'README.md']);
  await client.fastForward();
  assert.equal(await gitText(local, ['rev-parse', 'HEAD']), imported.head);
  assert.equal((await readFile(join(local, 'agent.txt'), 'utf8')).trim(), token);
  passed('optional fast-forward refused dirty local work, then advanced the clean source branch');
  await second.close(); second = undefined;
  await first.close(); first = undefined;
  await client.close();
  client = new GitWorkspaceClient(workspace, project, await discoverRepository(local), AbortSignal.timeout(5 * 60_000));
  await client.send(false);
  passed('closing both sessions released checkout ownership for a subsequent outbound sync');
  first = new RemoteAgent(workspace.session({ keepAliveSeconds: 120 }), options); approvals(first);
  await first.start(['--tools', 'Bash']);
  await runTurn(first, cleanupCommand); cleaned = true;
  passed('disposable remote checkout and transfer artifacts removed');
  report.commit = imported.head;
  if (process.env.JUICED_GIT_REPORT) await writeFile(process.env.JUICED_GIT_REPORT, JSON.stringify(report, null, 2) + '\n');
} finally {
  if (!cleaned && first?.status === 'ready' && runTurn && cleanupCommand) await runTurn(first, cleanupCommand).catch(() => {});
  await second?.close().catch(() => {}); await first?.close().catch(() => {}); await client?.close().catch(() => {});
  await rm(local, { recursive: true, force: true }); await rm(buildDirectory, { recursive: true, force: true });
}
