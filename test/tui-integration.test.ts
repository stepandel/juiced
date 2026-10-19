import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import { runLocalTui } from '../src/tui/app.js';
import type { TerminalInput, TerminalOutput } from '../src/remote-terminal.js';

test('slash commands preview, filter, navigate, complete and submit locally', { timeout: 5000 }, async () => {
  class CommandAgent extends RemoteAgent {
    submitted: string[] = [];
    interrupts = 0;
    override async start() {
      this.commands = [
        { name: 'compact', description: 'Summarize conversation', argumentHint: '[instructions]' },
        { name: 'compare', description: 'Compare project changes', argumentHint: '' },
        ...Array.from({ length: 20 }, (_, i) => ({ name: `project:command-${String(i).padStart(2, '0')}`, description: 'A project command', argumentHint: '' })),
      ];
      this.emit('commands', this.commands);
      this.status = 'ready'; this.emit('status', this.status);
    }
    override async submit(text: string) { this.submitted.push(text); this.status = 'working'; this.emit('status', this.status); }
    override async interrupt() { this.interrupts++; }
    override async close() { this.status = 'closed'; this.emit('status', this.status); }
  }
  const agent = new CommandAgent({} as AgentSession);
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  let latest = '';
  const frames: { text: string; rows: number }[] = [];
  const stdout = new Writable({ write(chunk, _, done) {
    const text = stripVTControlCharacters(chunk.toString());
    if (text.includes('Enter send')) { latest = text; frames.push({ text, rows: stdout.rows! }); }
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 24;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 200) throw new Error(`UI did not update: ${latest}`); await delay(5); } };
  try {
    await wait(() => agent.status === 'ready');
    stdin.write('/');
    await wait(() => latest.includes('Summarize conversation'));
    assert.ok(latest.includes('[instructions]'));
    stdin.write('comp');
    await wait(() => latest.includes('1/2 ·'));
    assert.equal(latest.includes('Show Juiced keyboard shortcuts'), false);
    stdin.write('\x1b[B'); stdin.write('\t');
    await wait(() => latest.includes('/compare ') && !latest.includes('Tab complete'));
    assert.deepEqual(agent.submitted, [], 'Completion must not submit a turn');
    stdin.write('\r');
    await wait(() => agent.submitted.length === 1);
    assert.deepEqual(agent.submitted, ['/compare ']);

    stdin.write('/comp');
    await wait(() => latest.includes('1/2 ·'));
    stdin.write('\x1b');
    await wait(() => !latest.includes('Tab complete'));
    assert.ok(latest.includes('/comp'), 'Escape keeps the draft');
    assert.equal(agent.interrupts, 0, 'Closing suggestions must not interrupt Claude');
    stdin.write('\x1b');
    await wait(() => agent.interrupts === 1);
    stdin.write('\x15');
    await wait(() => latest.includes('Ask Claude to work'));
    agent.status = 'ready'; agent.emit('status', agent.status);
    stdin.write('/comp');
    await wait(() => latest.includes('1/2 ·'));
    stdin.write('\x1b[B'); stdin.write('\r');
    await wait(() => agent.submitted.length === 2);
    assert.equal(agent.submitted[1], '/compare', 'Rapid arrow + Enter runs the selected command');

    stdin.write('/project:');
    await wait(() => latest.includes('1/20 ·'));
    for (let i = 0; i < 12; i++) stdin.write('\x1b[B');
    await wait(() => latest.includes('13/20 ·') && latest.includes('/project:command-12'));
    stdout.columns = 50; stdout.rows = 16; stdout.emit('resize');
    await delay(80);
    assert.ok(latest.includes('/project:command-12'), 'The selected row remains visible on resize');
    for (const frame of frames) assert.ok(frame.text.trimEnd().split('\n').length < frame.rows, `Command menu overflowed: ${frame.text}`);

    stdin.write('\x15');
    await wait(() => latest.includes('Ask Claude to work'));
    stdin.write('\x1b[200~/compact keep decisions\nsecond line\x1b[201~');
    await wait(() => latest.includes('second line'));
    assert.equal(latest.includes('Tab complete'), false);
    assert.equal(agent.submitted.length, 2, 'Pasted newlines must stay in the draft');
  } finally { lifetime.abort(); await running; }
  assert.equal(stdin.isRaw, false);
});

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
  assert.equal(stops, 0, 'Losing the local terminal must leave remote work running');
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
    await delay(40); // Let the newly mounted permission attach its input handler.
    stdin.write('\x1b[C'); stdin.write('\r');
    await wait(() => agent.answers.length === 2);
    assert.equal(agent.answers[1], true, 'A rapid arrow then Enter must confirm the selected choice');
  } finally { lifetime.abort(); await running; }
  assert.equal(stdin.isRaw, false);
});

test('long conversations and permission previews stay inside the terminal while switching options', { timeout: 5000 }, async () => {
  class PreviewAgent extends RemoteAgent {
    answers: boolean[] = [];
    questionAnswers: Record<string, string> | undefined;
    override async start() { this.status = 'ready'; this.emit('status', this.status); }
    override async submit() { this.status = 'working'; this.emit('status', this.status); }
    override async answer(id: string, allow: boolean, answers?: Record<string, string>) { this.answers.push(allow); this.questionAnswers = answers; this.approvals.delete(id); this.emit('approvals'); }
    override async close() { this.status = 'closed'; this.emit('status', this.status); }
  }
  const agent = new PreviewAgent({} as AgentSession);
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  const frames: { text: string; rows: number }[] = [];
  const writes: string[] = [];
  const stdout = new Writable({ write(chunk, _, done) {
    const text = stripVTControlCharacters(chunk.toString());
    writes.push(text);
    if (text.includes('Enter send') || text.includes('Esc decline')) frames.push({ text, rows: stdout.rows! });
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 60; stdout.rows = 24;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 200) throw new Error('UI did not update'); await delay(5); } };
  try {
    await wait(() => agent.status === 'ready');
    stdin.write('ORIGINAL_PROMPT'); await delay(40); stdin.write('\r');
    await wait(() => agent.status === 'working');
    for (let i = 0; i < 10; i++) agent.emit('frame', { type: 'assistant', message: { id: `message-${i}`, content: [{ type: 'text', text: `Response ${i}: ${'wrapped text '.repeat(12)}` }] } });
    agent.approvals.set('permission', { id: 'permission', tool: 'Bash', input: { command: Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join('\n') }, description: 'Check the command before allowing it.' });
    agent.emit('approvals');
    await wait(() => frames.some(frame => frame.text.includes('Allow Bash')));
    await delay(40);
    for (const key of ['\x1b[C', '\x1b[D', '\x1b[C', '\x1b[D']) { stdin.write(key); await delay(40); }
    stdout.columns = 42; stdout.rows = 16; stdout.emit('resize');
    await delay(80);
    stdin.write('\x1b[C'); await delay(40);
    stdin.write('\x1b[D'); await delay(40);
    stdin.write('\x1b[C'); stdin.write('\r');
    await wait(() => agent.answers.length === 1);
    assert.deepEqual(agent.answers, [true]);

    agent.approvals.set('question', { id: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which option?', options: Array.from({ length: 20 }, (_, i) => ({ label: `Option ${i + 1}`, description: 'A detailed option description that wraps onto multiple rows.' })) }] }, description: '' });
    agent.emit('approvals');
    await wait(() => frames.at(-1)?.text.includes('Claude has a question') ?? false);
    await delay(40); stdin.write('2'); await delay(40); stdin.write('\r');
    await wait(() => agent.answers.length === 2);
    assert.deepEqual(agent.questionAnswers, { 'Which option?': 'Option 2' });

    const offset = writes.length;
    agent.emit('frame', { type: 'result' });
    await wait(() => writes.slice(offset).join('').includes('ORIGINAL_PROMPT'));
    const transcript = writes.slice(offset).join('');
    assert.equal(transcript.match(/ORIGINAL_PROMPT/g)?.length, 1, 'The completed prompt must be printed once');
    for (let i = 0; i < 10; i++) assert.equal(transcript.match(new RegExp(`Response ${i}:`, 'g'))?.length, 1, 'Clipped responses must remain in completed history');

    stdin.write(`\x1b[200~${Array.from({ length: 30 }, (_, i) => `draft line ${i}`).join('\n')}\x1b[201~`);
    await wait(() => frames.at(-1)?.text.includes('draft line 29') ?? false);
    for (const frame of frames) {
      const lines = frame.text.trimEnd().split('\n');
      assert.ok(lines.length < frame.rows, `A ${lines.length}-row live frame overflows the ${frame.rows}-row terminal:\n${frame.text}`);
      if (frame.text.includes('Esc decline')) {
        if (frame.text.includes('Claude has a question')) assert.ok(frame.text.includes('Which option?'), 'The question must stay visible');
        else {
          assert.ok(frame.text.includes('Allow Bash'), 'The permission title must stay visible');
          assert.ok(frame.text.includes('Deny') && frame.text.includes('Allow once'), 'Both approval choices must stay visible');
        }
      }
    }
  } finally { lifetime.abort(); await running; }
  assert.equal(stdout.listenerCount('resize'), 0);
});
