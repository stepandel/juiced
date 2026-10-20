import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import type { Approval, ApprovalOptions } from '../src/agent-protocol.js';
import { runLocalTui } from '../src/tui/app.js';
import type { TerminalInput, TerminalOutput } from '../src/remote-terminal.js';
import { until } from './fixtures/wait.js';

test('reattaching prints saved turns and the entire unfinished turn into scrollback', { timeout: 5000 }, async () => {
  class ReattachedAgent extends RemoteAgent {
    submitted: string[] = [];
    override async start() {
      for (let i = 0; i < 2; i++) {
        this.emit('frame', { type: 'juiced_user', text: `SAVED_PROMPT_${i}` });
        this.emit('frame', { type: 'result', result: `SAVED_ANSWER_${i}` });
      }
      this.emit('frame', { type: 'juiced_user', text: 'UNFINISHED_PROMPT' });
      for (let i = 0; i < 24; i++) this.emit('frame', { type: 'assistant', message: { id: `saved-${i}`, content: [{ type: 'text', text: `SAVED_PROGRESS_${i}: ${'wrapped text '.repeat(8)}` }] } });
      this.approvals.set('permission', { id: 'permission', tool: 'Write', input: { file_path: 'README.md' }, description: '' });
      this.emit('approvals');
      this.status = 'working'; this.emit('status', this.status);
    }
    override async submit(text: string) { this.submitted.push(text); }
    override async close() { this.status = 'closed'; this.emit('status', this.status); }
  }
  const agent = new ReattachedAgent({ id: 'saved-session' } as AgentSession);
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  const writes: string[] = [];
  const stdout = new Writable({ write(chunk, _, done) { writes.push(chunk.toString().includes('\x1b[3J') ? '<CLEARED>' : stripVTControlCharacters(chunk.toString())); done(); } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 60; stdout.rows = 16;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = (check: () => boolean) => until(check, { attempts: 200, message: () => `UI did not update: ${writes.join('')}` });
  try {
    await wait(() => writes.join('').includes('Create file'));
    const markers = ['SAVED_PROMPT_0', 'SAVED_ANSWER_0', 'SAVED_PROMPT_1', 'SAVED_ANSWER_1', 'UNFINISHED_PROMPT', ...Array.from({ length: 24 }, (_, i) => `SAVED_PROGRESS_${i}:`)];
    await wait(() => markers.every(marker => writes.join('').includes(marker))).catch(() => {});
    const restored = writes.join('');
    for (const marker of markers) {
      assert.ok(restored.includes(marker), `Missing saved history: ${marker}`);
    }
    assert.deepEqual(agent.submitted, [], 'Displaying history must not send a prompt');
    assert.equal(agent.approvals.size, 1, 'Displaying history must leave approval pending');

    let offset = writes.length;
    agent.emit('reconnecting'); agent.emit('reconnected');
    stdout.rows = 18; stdout.emit('resize');
    // Negative check: outlast the 50 ms reflow timer in src/tui/app.tsx before asserting nothing reprinted.
    await delay(80);
    assert.equal(writes.slice(offset).join('').includes('SAVED_PROGRESS_0:'), false, 'Repaints must not print the history again');

    // A narrower terminal clears scrollback once and reflows saved turns to the new width.
    offset = writes.length;
    for (const columns of [55, 50]) { stdout.columns = columns; stdout.emit('resize'); }
    await wait(() => writes.slice(offset).join('').includes('SAVED_ANSWER_1'));
    await delay(80); // Outlast another reflow timer so a second clear would be observed.
    const reflowed = writes.slice(offset).join('');
    assert.equal(reflowed.split('<CLEARED>').length, 2, 'Resizing clears the screen once after the width settles');
    assert.equal(reflowed.split('<CLEARED>')[1]!.split('SAVED_PROMPT_0').length, 2, 'Saved turns print exactly once after the clear');
    assert.ok(reflowed.split('<CLEARED>')[1]!.split('\n').every(line => line.length <= 50), 'Reflowed lines fit the new width');
    offset = writes.length;

    agent.emit('frame', { type: 'assistant', message: { id: 'new-answer', content: [{ type: 'text', text: 'NEW_OUTPUT_AFTER_REATTACH' }] } });
    agent.approvals.clear(); agent.emit('approvals');
    agent.emit('frame', { type: 'result' });
    await wait(() => writes.slice(offset).join('').includes('NEW_OUTPUT_AFTER_REATTACH'));
    assert.equal(writes.slice(offset).join('').includes('SAVED_PROGRESS_0:'), false, 'Finishing the turn must not repeat restored output');
  } finally { lifetime.abort(); await running; }
});

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
    if (text.includes('mode on')) { latest = text; frames.push({ text, rows: stdout.rows! }); }
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 24;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = (check: () => boolean) => until(check, { attempts: 200, message: () => `UI did not update: ${latest}` });
  try {
    await wait(() => agent.status === 'ready');
    stdin.write('/');
    await wait(() => latest.includes('Summarize conversation'));
    assert.ok(latest.includes('[instructions]'));
    stdin.write('comp');
    await wait(() => latest.includes('❯ /compact') && latest.includes('/compare') && latest.includes('Compare project changes'));
    assert.equal(latest.includes('Show Juiced keyboard shortcuts'), false);
    stdin.write('\x1b[B'); stdin.write('\t');
    await wait(() => latest.includes('❯ /compare') && !latest.includes('Compare project changes'));
    assert.deepEqual(agent.submitted, [], 'Completion must not submit a turn');
    stdin.write('\r');
    await wait(() => agent.submitted.length === 1);
    assert.deepEqual(agent.submitted, ['/compare ']);

    stdin.write('/comp');
    await wait(() => latest.includes('Compare project changes'));
    stdin.write('\x1b');
    await wait(() => !latest.includes('Compare project changes'));
    assert.ok(latest.includes('/comp'), 'Escape keeps the draft');
    assert.equal(agent.interrupts, 0, 'Closing suggestions must not interrupt Claude');
    stdin.write('\x1b');
    await wait(() => agent.interrupts === 1);
    stdin.write('\x15');
    await wait(() => latest.includes('Ask Claude to work'));
    agent.status = 'ready'; agent.emit('status', agent.status);
    stdin.write('/comp');
    await wait(() => latest.includes('Compare project changes'));
    stdin.write('\x1b[B'); stdin.write('\r');
    await wait(() => agent.submitted.length === 2);
    assert.equal(agent.submitted[1], '/compare', 'Rapid arrow + Enter runs the selected command');

    stdin.write('/project:');
    await wait(() => latest.includes('❯ /project:command-00'));
    for (let i = 0; i < 12; i++) stdin.write('\x1b[B');
    await wait(() => latest.includes('❯ /project:command-12'));
    stdout.columns = 50; stdout.rows = 16; stdout.emit('resize');
    await delay(80); // Include frames from the 50 ms reflow reprint in the overflow check below.
    assert.ok(latest.includes('/project:command-12'), 'The selected row remains visible on resize');
    for (const frame of frames) assert.ok(frame.text.trimEnd().split('\n').length < frame.rows, `Command menu overflowed: ${frame.text}`);

    stdin.write('\x15');
    await wait(() => latest.includes('Ask Claude to work'));
    stdin.write('\x1b[200~/compact keep decisions\nsecond line\x1b[201~');
    await wait(() => latest.includes('second line'));
    assert.equal(latest.includes('A project command'), false);
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
    await until(() => requests > 0, { attempts: 100 }).catch(() => {});
    stdin.write('LOCAL_EDIT_🍈');
    await until(() => output.includes('LOCAL_EDIT_🍈'), 500).catch(() => {});
    assert.ok(output.includes('LOCAL_EDIT_🍈'), 'The draft should render before any remote response');
    assert.equal(dispatches, 0);
    stdin.write('\x1b[D'); stdin.write('\x7f');
    await until(() => stripVTControlCharacters(output).includes('LOCAL_EDIT🍈'), { attempts: 200, message: () => `Left and backspace should edit locally: ${stripVTControlCharacters(output).slice(-3000)}` });
    stdin.write('\x1b[200~\npasted second line\n\x1b[201~');
    await until(() => stripVTControlCharacters(output).includes('pasted second line'), { attempts: 200 });
    assert.equal(dispatches, 0, 'Pasted newlines must not submit a prompt');
  } finally { lifetime.abort(); await running; }
  assert.equal(stops, 0, 'Losing the local terminal must leave remote work running');
  assert.equal(stdin.isRaw, false);
});

test('permission UI preselects Yes, ignores early and pasted keys, offers remembered grants and feedback, and preserves the draft', { timeout: 5000 }, async () => {
  class PreviewAgent extends RemoteAgent {
    answers: { allow: boolean; options?: ApprovalOptions }[] = [];
    override async start() { this.status = 'ready'; this.emit('status', this.status); }
    override async answer(id: string, allow: boolean, _?: Record<string, string>, options?: ApprovalOptions) { this.answers.push({ allow, ...(options ? { options } : {}) }); this.approvals.delete(id); this.emit('approvals'); }
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
  const wait = (check: () => boolean) => until(check, { attempts: 200, message: 'UI did not update' });
  const ask = async (id: string, extra: Partial<Approval> = {}) => {
    const offset = output.length;
    agent.approvals.set(id, { id, tool: 'Bash', input: { command: 'printf OK' }, description: '', ...extra });
    agent.emit('approvals');
    await wait(() => stripVTControlCharacters(output.slice(offset)).includes(extra.local ? 'in your local checkout?' : 'Bash command'));
    return offset;
  };
  try {
    await wait(() => agent.status === 'ready');
    stdin.write('my draft'); await wait(() => stripVTControlCharacters(output).includes('my draft'));
    await ask('first');
    stdin.write('\r'); stdin.write('1'); await delay(40); // Negative check: no event marks ignored keys.
    assert.deepEqual(agent.answers, [], 'Keys typed for the prompt as the dialog opens must not answer it');
    // 320 ms outlasts the dialog's 300 ms settle window (src/tui/app.tsx), so Enter below is accepted.
    stdin.write('\x1b[200~y\x1b[201~'); await delay(320);
    assert.deepEqual(agent.answers, [], 'Pasting y must not approve a tool');
    stdin.write('\r'); await wait(() => agent.answers.length === 1);
    assert.deepEqual(agent.answers[0], { allow: true }, 'Yes is preselected');
    assert.ok(stripVTControlCharacters(output).includes('my draft'));

    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'printf:*' }], behavior: 'allow', destination: 'localSettings' }];
    const offset = await ask('second', { suggestions });
    assert.ok(stripVTControlCharacters(output.slice(offset)).includes('2. Yes, and don’t ask again for Bash(printf:*) in this project'));
    await delay(320); // Settle window.
    stdin.write('\x1b[B'); stdin.write('\r');
    await wait(() => agent.answers.length === 2);
    assert.deepEqual(agent.answers[1], { allow: true, options: { suggestions } }, 'A rapid arrow then Enter confirms the remembered grant');

    await ask('third');
    await delay(40); stdin.write('\t'); await wait(() => output.includes('Tell Claude what to do differently'));
    await delay(40); stdin.write('use echo instead'); await wait(() => stripVTControlCharacters(output).includes('use echo instead')); stdin.write('\r');
    await wait(() => agent.answers.length === 3);
    assert.deepEqual(agent.answers[2], { allow: false, options: { message: 'use echo instead' } });

    await ask('local-publication', { local: true, tool: 'Publish snapshot', input: { files: 2, paths: ['README.md', 'src/app.ts'] }, description: 'Apply remote edits locally' });
    await delay(320); // Settle window.
    stdin.write('\x1b[200~y\x1b[201~'); await delay(40); // Negative check.
    assert.equal(agent.answers.length, 3, 'Pasted text cannot approve a local publication');
    stdin.write('\r'); await wait(() => agent.answers.length === 4);
    assert.deepEqual(agent.answers[3], { allow: false }, 'Local publication defaults to No');
  } finally { lifetime.abort(); await running; }
  assert.equal(stdin.isRaw, false);
});

test('questions ignore early selections and approval feedback remains interruptible', { timeout: 5000 }, async () => {
  class PermissionAgent extends RemoteAgent {
    answers: { allow: boolean; answers?: Record<string, string> }[] = [];
    interrupts = 0;
    override async start() { this.status = 'working'; this.emit('status', this.status); }
    override async answer(id: string, allow: boolean, answers?: Record<string, string>) {
      this.answers.push({ allow, ...(answers ? { answers } : {}) }); this.approvals.delete(id); this.emit('approvals');
    }
    override async interrupt() { this.interrupts++; }
    override async close() { this.status = 'closed'; this.emit('status', this.status); }
  }
  const agent = new PermissionAgent({} as AgentSession);
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  let latest = '';
  const stdout = new Writable({ write(chunk, _, done) {
    const text = stripVTControlCharacters(chunk.toString());
    if (text.includes('──')) latest = text;
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 30;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = (check: () => boolean) => until(check, { attempts: 200, message: () => `UI did not update: ${latest}` });
  try {
    await wait(() => agent.status === 'working');
    agent.approvals.set('question', { id: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Choose a target', options: [{ label: 'Staging' }, { label: 'Production' }] }] }, description: '' });
    agent.emit('approvals');
    await wait(() => latest.includes('Choose a target'));
    await delay(40);
    stdin.write('\r'); stdin.write('2'); stdin.write('\x1b[200~1\x1b[201~');
    await delay(40);
    assert.deepEqual(agent.answers, [], 'Prompt keys arriving with a question must not select an answer');
    stdin.write('\x03'); await wait(() => agent.interrupts === 1);
    await delay(320); // Settle window.
    stdin.write('\r'); await wait(() => agent.answers.length === 1);
    assert.deepEqual(agent.answers, [{ allow: true, answers: { 'Choose a target': 'Staging' } }]);

    agent.approvals.set('command', { id: 'command', tool: 'Bash', input: { command: 'pwd' }, description: '' });
    agent.emit('approvals');
    await wait(() => latest.includes('Bash command'));
    await delay(40); stdin.write('\t');
    await wait(() => latest.includes('Tell Claude what to do differently'));
    await delay(40); stdin.write('Keep this draft'); await wait(() => latest.includes('Keep this draft')); stdin.write('\x03');
    await wait(() => agent.interrupts === 2);
    assert.equal(agent.answers.length, 1, 'Interrupting from feedback must not answer the approval');
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
    if (text.includes('mode on') || text.includes('Esc to cancel')) frames.push({ text, rows: stdout.rows! });
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 60; stdout.rows = 24;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = (check: () => boolean) => until(check, { attempts: 200, message: 'UI did not update' });
  try {
    await wait(() => agent.status === 'ready');
    stdin.write('ORIGINAL_PROMPT'); await wait(() => writes.join('').includes('ORIGINAL_PROMPT')); stdin.write('\r');
    await wait(() => agent.status === 'working');
    for (let i = 0; i < 10; i++) agent.emit('frame', { type: 'assistant', message: { id: `message-${i}`, content: [{ type: 'text', text: `Response ${i}: ${'wrapped text '.repeat(12)}` }] } });
    agent.approvals.set('permission', { id: 'permission', tool: 'Bash', input: { command: Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join('\n') }, description: 'Check the command before allowing it.' });
    agent.emit('approvals');
    await wait(() => frames.some(frame => frame.text.includes('Bash command')));
    await delay(40);
    for (const key of ['\x1b[C', '\x1b[D', '\x1b[C', '\x1b[D']) { stdin.write(key); await delay(40); }
    stdout.columns = 42; stdout.rows = 16; stdout.emit('resize');
    await delay(80); // Outlast the 50 ms reflow timer.
    stdin.write('\x1b[C'); await delay(40);
    stdin.write('\x1b[D'); await delay(40);
    stdin.write('\x1b[C'); stdin.write('\x1b[D'); stdin.write('\r');
    await wait(() => agent.answers.length === 1);
    assert.deepEqual(agent.answers, [true]);

    agent.approvals.set('question', { id: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which option?', options: Array.from({ length: 20 }, (_, i) => ({ label: `Option ${i + 1}`, description: 'A detailed option description that wraps onto multiple rows.' })) }] }, description: '' });
    agent.emit('approvals');
    await wait(() => frames.at(-1)?.text.includes('Which option?') ?? false);
    await delay(320); /* Settle window. */ stdin.write('2'); await delay(40); stdin.write('\r');
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
      if (frame.text.includes('Esc to cancel')) {
        if (frame.text.includes('Which option?')) assert.ok(frame.text.includes('Which option?'), 'The question must stay visible');
        else {
          assert.ok(frame.text.includes('Bash command'), 'The permission title must stay visible');
          assert.ok(frame.text.includes('1. Yes') && frame.text.includes('2. No'), 'Both approval choices must stay visible');
        }
      }
    }
  } finally { lifetime.abort(); await running; }
  assert.equal(stdout.listenerCount('resize'), 0);
});

test('Claude Code prompt keys: history, shortcuts, mode cycling, double Esc and double Ctrl-C', { timeout: 5000 }, async () => {
  class KeyAgent extends RemoteAgent {
    submitted: string[] = [];
    modes: string[] = [];
    refuseAuto = false;
    override async start() { this.info.current_permission_mode = 'default'; this.status = 'ready'; this.emit('status', this.status); }
    override async submit(text: string) {
      this.submitted.push(text);
      this.emit('frame', { type: 'result', result: `Answer ${this.submitted.length}`, duration_ms: 1000 });
    }
    override async configure(request: Parameters<RemoteAgent['configure']>[0], options?: Parameters<RemoteAgent['configure']>[1]) {
      this.status = 'configuring'; this.emit('status', this.status);
      if (options?.persist !== false) throw new Error('Shift+Tab must not save a workspace default');
      if (request.subtype === 'set_permission_mode' && request.mode === 'auto' && this.refuseAuto) {
        this.modes.push('auto refused'); this.status = 'ready'; this.emit('status', this.status);
        throw new Error('Cannot set permission mode: auto mode is not available');
      }
      if (request.subtype === 'set_permission_mode') { this.modes.push(request.mode); this.info.current_permission_mode = request.mode; }
      this.status = 'ready'; this.emit('status', this.status);
      return {};
    }
    override async close() { this.status = 'closed'; this.emit('status', this.status); }
  }
  const agent = new KeyAgent({} as AgentSession);
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  let latest = '';
  const stdout = new Writable({ write(chunk, _, done) { const text = stripVTControlCharacters(chunk.toString()); if (text.includes('──')) latest = text; done(); } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 100; stdout.rows = 24;
  const lifetime = new AbortController();
  let exited = false;
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal).then(code => { exited = true; return code; });
  const wait = (check: () => boolean) => until(check, { attempts: 200, message: () => `UI did not update: ${latest}` });
  const prompt = () => /❯ (.*)\n─/u.exec(latest)?.[1]?.trimEnd();
  try {
    await wait(() => latest.includes('manual mode on · ? for shortcuts'));
    for (const text of ['first prompt', 'second prompt']) {
      stdin.write(text); await wait(() => prompt() === text); stdin.write('\r');
      await wait(() => latest.includes('? for shortcuts') && prompt()?.startsWith('Ask Claude') === true);
    }
    stdin.write('draft'); await wait(() => prompt() === 'draft');
    stdin.write('\x1b[A'); await wait(() => prompt() === 'second prompt');
    stdin.write('\x1b[A'); await wait(() => prompt() === 'first prompt');
    stdin.write('\x1b[B'); stdin.write('\x1b[B'); await wait(() => prompt() === 'draft');

    stdin.write('\x1b'); await wait(() => latest.includes('Esc again to clear'));
    assert.equal(prompt(), 'draft', 'One Esc keeps the draft');
    stdin.write('\x1b'); await wait(() => prompt()?.startsWith('Ask Claude') === true);

    stdin.write('?'); await wait(() => latest.includes('shift + tab to cycle modes'));
    assert.ok(prompt()?.startsWith('Ask Claude'), '? opens shortcuts without editing the draft');
    stdin.write('x'); await wait(() => prompt() === 'x' && !latest.includes('shift + tab to cycle modes'));
    stdin.write('\x15'); await wait(() => prompt()?.startsWith('Ask Claude') === true);

    stdin.write('\x1b[Z'); await wait(() => latest.includes('accept edits on (shift+tab to cycle)'));
    stdin.write('\x1b[Z'); await wait(() => latest.includes('plan mode on'));
    stdin.write('\x1b[Z'); await wait(() => latest.includes('auto mode on'));
    stdin.write('\x1b[Z'); await wait(() => latest.includes('manual mode on'));
    agent.refuseAuto = true;
    for (const mode of ['accept edits on', 'plan mode on', 'manual mode on', 'accept edits on', 'plan mode on', 'manual mode on']) { stdin.write('\x1b[Z'); await wait(() => latest.includes(mode)); }
    assert.deepEqual(agent.modes, ['acceptEdits', 'plan', 'auto', 'default', 'acceptEdits', 'plan', 'auto refused', 'default', 'acceptEdits', 'plan', 'default'], 'A refused auto mode is skipped silently and not retried');
    assert.equal(latest.includes('not available'), false);
    assert.deepEqual(agent.submitted, ['first prompt', 'second prompt']);

    stdin.write('draft'); await wait(() => prompt() === 'draft');
    stdin.write('\x0f'); await wait(() => latest.includes('Showing detailed transcript') && latest.includes('Answer 2') && latest.includes('❯ first prompt'));
    stdin.write('x'); await delay(30);
    stdin.write('\x1b'); await wait(() => prompt() === 'draft');
    stdin.write('\x15'); await wait(() => prompt()?.startsWith('Ask Claude') === true);

    stdin.write('\x03'); await wait(() => latest.includes('Press Ctrl-C again to exit'));
    await delay(30);
    assert.equal(exited, false, 'One Ctrl-C on an empty prompt does not exit');
    stdin.write('\x03'); await wait(() => exited);
  } finally { lifetime.abort(); await running; }
  assert.equal(stdin.isRaw, false);
});
