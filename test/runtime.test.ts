import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createTerminal } from '../src/runtime/terminal.js';
import { decodeInput, type TerminalCommand, type TerminalEvent } from '../src/protocol.js';

const start = (argv: string[], tty = false): Extract<TerminalCommand, { type: 'start' }> => ({ type: 'start', argv, tty, columns: 91, rows: 32, term: 'xterm-256color' });

async function fixture(t: test.TestContext) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'juiced-test-')));
  const lifetime = new AbortController();
  const terminal = createTerminal({ signal: lifetime.signal, session: { id: 'test', keepAliveSeconds: 120 }, env: {}, database: async () => { throw new Error('unused'); } },
    { workspace, binary: process.execPath });
  t.after(async () => { lifetime.abort(); terminal.cancel(); await rm(workspace, { recursive: true, force: true }); });
  const events: TerminalEvent[] = [];
  const output = { async send(event: TerminalEvent) { events.push(event); } };
  const text = (channel: 'stdout' | 'stderr' = 'stdout') => Buffer.concat(events.filter(event => event.type === 'output' && event.channel === channel).map(event => Buffer.from((event as Extract<TerminalEvent, { type: 'output' }>).data, 'base64'))).toString();
  const waitFor = async (value: string) => {
    const deadline = Date.now() + 5000;
    while (!text().includes(value)) {
      if (Date.now() > deadline) throw new Error(`Expected ${value}, received ${text()} / ${text('stderr')}`);
      await delay(10);
    }
  };
  return { terminal, events, output, text, waitFor, signal: lifetime.signal, workspace };
}

test('pipe mode preserves argv, stdin, stdout, stderr, workspace environment and exit code', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const run = f.terminal.run(start(['-e', `
    console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,tty:!!process.stdin.isTTY,apiKey:process.env.ANTHROPIC_API_KEY??null}));
    process.stderr.write('warning\\n');
    process.stdout.write('READY\\n');
    process.stdin.pipe(process.stdout);
    process.stdin.on('end', () => process.exitCode = 7);
  `, 'literal; $(no-shell)', 'two words']), { signal: f.signal, output: f.output });
  await f.waitFor('READY');
  await f.terminal.input({ type: 'input', data: Buffer.from('hello 🍈\n').toString('base64') });
  await f.terminal.input({ type: 'eof' });
  await run;
  const metadata = JSON.parse(f.text().split('\n')[0]!);
  assert.deepEqual(metadata.args, ['literal; $(no-shell)', 'two words']);
  assert.equal(metadata.cwd, f.workspace);
  assert.equal(metadata.home, f.workspace);
  assert.equal(metadata.config, join(f.workspace, '.claude'));
  assert.equal(metadata.tty, false);
  assert.equal(metadata.apiKey, null);
  assert.match(f.text(), /hello 🍈/);
  assert.equal(f.text('stderr'), 'warning\n');
  assert.deepEqual(f.events.at(-1), { type: 'exit', code: 7 });
});

test('PTY gives Claude a terminal, forwards raw input and applies resizes', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const run = f.terminal.run(start(['-e', `
    process.stdin.setRawMode(true);
    console.log('TTY:'+[process.stdin.isTTY,process.stdout.isTTY,process.stdout.columns,process.stdout.rows].join(','));
    process.stdout.on('resize', () => console.log('RESIZE:'+process.stdout.columns+','+process.stdout.rows));
    process.stdin.on('data', bytes => {
      console.log('KEY:'+bytes.toString('hex'));
      if(bytes.includes(113)) process.exit(3);
    });
  `], true), { signal: f.signal, output: f.output });
  await f.waitFor('TTY:true,true,91,32');
  await f.terminal.input({ type: 'resize', columns: 120, rows: 45 });
  await f.waitFor('RESIZE:120,45');
  await f.terminal.input({ type: 'input', data: Buffer.from([3]).toString('base64') });
  await f.waitFor('KEY:03');
  await f.terminal.input({ type: 'input', data: Buffer.from('q').toString('base64') });
  await run;
  assert.deepEqual(f.events.at(-1), { type: 'exit', code: 3 });
});

test('cancellation reaps a PTY process that ignores SIGTERM', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const run = f.terminal.run(start(['-e', `process.on('SIGTERM',()=>{}); console.log('READY'); setInterval(()=>{},1000);`], true), { signal: f.signal, output: f.output });
  await f.waitFor('READY');
  assert.equal(f.terminal.cancel(), true);
  await run;
  assert.deepEqual(f.events.at(-1), { type: 'exit', code: 137 });
  assert.equal(f.terminal.cancel(), false);
});

test('rejects malformed and oversized input and duplicate starts', { timeout: 10_000 }, async t => {
  assert.throws(() => decodeInput('%%invalid'), /Invalid/);
  assert.throws(() => decodeInput(Buffer.alloc(17 * 1024).toString('base64')), /Invalid|large/);
  const f = await fixture(t);
  await f.terminal.run(start(['-e', 'process.exit(0)']), { signal: f.signal, output: f.output });
  await assert.rejects(f.terminal.run(start([]), { signal: f.signal, output: f.output }), /exactly one/);
});
