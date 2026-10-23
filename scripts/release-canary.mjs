import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export const canaryPolicy = { maxSandboxes: null, maxVcpus: null, maxMemoryMib: null,
  maxWorkspaces: 8, maxStorageBytes: 10 * 1024 ** 3 };

export async function qualifyInstance(instance, expected, runTerminal, signal, sleep = delay) {
  let failure;
  try {
    let status = await instance.create({ signal });
    const policy = await instance.setPolicy({ signal, expectedRevision: status.policyRevision,
      policy: { ...canaryPolicy, active: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } });
    while (status.state !== 'ready' || status.enforcedRevision < policy.revision) {
      signal.throwIfAborted();
      await sleep(2000, undefined, { signal });
      status = await instance.status({ signal });
      assert.ok(status && status.state !== 'failed', 'Release canary failed provisioning');
    }
    assert.equal(status.packageId, expected.packageId);
    assert.equal(status.runtimeId, expected.runtimeId);
    const session = (await instance.app({ signal })).workspace({ slug: 'release-canary' }).session({ keepAliveSeconds: 30 });
    const input = new PassThrough(); input.end();
    let output = '';
    const sink = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    const code = await runTerminal(session, ['--version'], { stdin: input, stdout: sink, stderr: sink }, { signal, term: 'dumb' });
    assert.equal(code, 0);
    assert.match(output, /\d+\.\d+\.\d+.*Claude Code/i);
    console.log('Runtime canary passed:', output.trim());
  } catch (error) { failure = error; }
  // Creation can commit even if its response is lost. Always delete by our unique external key.
  try { await instance.delete({ signal: AbortSignal.timeout(120_000) }); }
  catch (error) {
    if (!(error.status === 404 && error.code === 'not_found'))
      throw new AggregateError([failure, error].filter(Boolean), 'Release canary cleanup failed');
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [integration, generation, directory] = process.argv.slice(2);
  process.env.CANTELOP_APP_CONFIG = await readFile(integration, 'utf8');
  const { fleet } = await import('../dist/cantelop/backend/client.mjs');
  const { runRemoteTerminal } = await import('../src/remote-terminal.ts');
  const configured = fleet.withProfile('worker');
  const binding = JSON.parse(process.env.CANTELOP_APP_CONFIG).profiles.worker.fleets.find(f => f.name === 'juiced');
  const record = join(directory, 'canary.json');
  try {
    const previous = JSON.parse(await readFile(record));
    assert.ok(previous.externalKey.startsWith(`release-${generation}-`));
    await configured.instance({ externalKey: previous.externalKey }).delete({ signal: AbortSignal.timeout(120_000) });
    await rm(record);
  } catch (error) { if (error.code !== 'ENOENT' && !(error.status === 404 && error.code === 'not_found')) throw error; }
  const externalKey = `release-${generation}-${randomUUID()}`;
  await writeFile(record, JSON.stringify({ externalKey }), { mode: 0o600 });
  await qualifyInstance(configured.instance({ externalKey }), binding, runRemoteTerminal, AbortSignal.timeout(5 * 60_000));
  await rm(record);
}
