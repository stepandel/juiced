import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import { runLocalTui } from '../src/tui/app.js';
import type { TerminalInput, TerminalOutput } from '../src/remote-terminal.js';

test('the real TUI edits and displays input while the network is stalled, without sending keystrokes', { timeout: 5000 }, async () => {
  let requests = 0, dispatches = 0, stops = 0;
  const session: AgentSession = {
    id: 'local-edit-test',
    async request(_, options) {
      requests++;
      await new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
      return { ok: true };
    },
    async dispatch() { dispatches++; throw new Error('Typing must never dispatch'); },
    async *stream() { throw new Error('The stalled start must not open a stream'); },
    async stop() { stops++; },
  };
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  let output = '';
  const stdout = new Writable({ write(chunk, _, done) { output += chunk.toString(); done(); } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 30;
  const stderr = new PassThrough();
  const lifetime = new AbortController();
  const running = runLocalTui(new RemoteAgent(session), [], 'default', { stdin, stdout, stderr }, lifetime.signal);
  try {
    for (let i = 0; !requests && i < 100; i++) await delay(5);
    stdin.write('LOCAL_EDIT_🍈');
    const start = performance.now();
    while (!output.includes('LOCAL_EDIT_🍈') && performance.now() - start < 500) await delay(5);
    assert.ok(output.includes('LOCAL_EDIT_🍈'), 'The draft should render before any remote response');
    assert.equal(dispatches, 0);
    stdin.write('\x1b[D'); stdin.write('\x7f');
    await delay(60);
    assert.ok(stripVTControlCharacters(output).includes('LOCAL_EDIT🍈'), `Left and backspace should edit locally: ${stripVTControlCharacters(output).slice(-3000)}`);
    stdin.write('\x1b[200~\npasted second line\n\x1b[201~');
    await delay(50);
    assert.ok(stripVTControlCharacters(output).includes('pasted second line'));
    assert.equal(dispatches, 0, 'Pasted newlines must not submit a prompt');
  } finally { lifetime.abort(); await running; }
  assert.equal(stops, 1);
  assert.equal(stdin.isRaw, false);
});

test('permission UI defaults to deny, ignores pasted approval shortcuts and preserves the local draft', { timeout: 5000 }, async () => {
  class PreviewAgent extends RemoteAgent {
    answers: boolean[] = [];
    override async start() { this.status = 'ready'; this.emit('status', this.status); }
    override async answer(id: string, allow: boolean) { this.answers.push(allow); this.approvals.delete(id); this.emit('approvals'); }
    override async close() { this.status = 'closed'; this.emit('status', this.status); }
  }
  const agent = new PreviewAgent({} as AgentSession);
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  let output = '';
  const stdout = new Writable({ write(chunk, _, done) { output += chunk.toString(); done(); } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 30;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 200) throw new Error('UI did not update'); await delay(5); } };
  try {
    await wait(() => agent.status === 'ready');
    stdin.write('my draft'); await delay(40);
    agent.approvals.set('first', { id: 'first', tool: 'Bash', input: { command: 'printf OK' }, description: '' });
    agent.emit('approvals');
    await wait(() => output.includes('Allow Bash'));
    stdin.write('\x1b[200~y\x1b[201~'); await delay(40);
    assert.deepEqual(agent.answers, [], 'Pasting y must not approve a tool');
    stdin.write('\r'); await wait(() => agent.answers.length === 1);
    assert.equal(agent.answers[0], false);
    await delay(40);
    assert.ok(stripVTControlCharacters(output).includes('my draft'));
    const offset = output.length;
    agent.approvals.set('second', { id: 'second', tool: 'Bash', input: { command: 'printf OK' }, description: '' });
    agent.emit('approvals');
    await wait(() => output.slice(offset).includes('Allow Bash'));
    stdin.write('\x1b[C'); stdin.write('\r');
    await wait(() => agent.answers.length === 2);
    assert.equal(agent.answers[1], true, 'A rapid arrow then Enter must confirm the selected choice');
  } finally { lifetime.abort(); await running; }
  assert.equal(stdin.isRaw, false);
});
