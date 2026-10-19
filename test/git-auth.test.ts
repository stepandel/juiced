import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTerminal } from '../src/runtime/terminal.js';
import type { TerminalEvent } from '../src/protocol.js';

test('sandbox Git invokes its credential helper with the injected token; unrelated runtime secrets stay private', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'juiced-git-auth-')));
  const bin = join(root, 'bin'); await mkdir(bin);
  const helper = join(bin, 'gh');
  await writeFile(helper, `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='auth git-credential get')process.exit(1);\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write('username=x-access-token\\npassword='+process.env.GH_TOKEN+'\\n\\n'));\n`);
  await chmod(helper, 0o755);
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  t.after(async () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController(); const events: TerminalEvent[] = [];
  const terminal = createTerminal({ signal: controller.signal, session: { id: 'git-auth', keepAliveSeconds: 120 }, env: { GH_TOKEN: 'fixture-token', OTHER_SECRET: 'do-not-forward' }, database: async () => { throw new Error('unexpected database access'); } }, { workspace: root, binary: process.execPath });
  const script = `const {spawnSync}=require('node:child_process');const result=spawnSync('git',['credential','fill'],{input:'protocol=https\\nhost=github.com\\n\\n',encoding:'utf8'});console.log(JSON.stringify({ok:result.status===0&&result.stdout.includes('password=fixture-token'),unrelated:process.env.OTHER_SECRET!==undefined}));`;
  await terminal.run({ type: 'start', argv: ['-e', script], tty: false, columns: 80, rows: 24, term: 'dumb' }, { signal: controller.signal, output: { async send(event) { events.push(event); } } });
  const output = events.filter(event => event.type === 'output').map(event => Buffer.from(event.data, 'base64').toString()).join('');
  assert.deepEqual(JSON.parse(output), { ok: true, unrelated: false });
  assert.doesNotMatch(output, /fixture-token|do-not-forward/);
});
