import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { RemoteAgent, type AgentSession } from '../src/remote-agent.js';
import { runLocalTui } from '../src/tui/app.js';
import type { TerminalInput, TerminalOutput } from '../src/remote-terminal.js';

class ModelAgent extends RemoteAgent {
  override models = [
    { value: 'default', displayName: 'Default', description: 'Use the default model' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks' },
    { value: 'opus', displayName: 'Opus', description: 'For complex tasks' },
    ...Array.from({ length: 8 }, (_, i) => ({ value: `custom-${i}`, displayName: `Custom ${i}`, description: 'A provider-specific model with a description that wraps on narrow terminals.' })),
  ];
  starts = 0;
  submitted: string[] = [];
  changes: { value: string; resolve(): void; reject(error: Error): void }[] = [];
  override async start() {
    this.starts++; this.emit('models', this.models); this.emit('model', this.model);
    this.status = 'ready'; this.emit('status', this.status);
  }
  override async setModel(value: string) {
    this.status = 'configuring'; this.emit('status', this.status);
    try {
      await new Promise<void>((resolve, reject) => this.changes.push({ value, resolve, reject }));
      this.model = value; this.emit('model', value);
    } finally { this.status = 'ready'; this.emit('status', this.status); }
  }
  override async submit(text: string) { this.submitted.push(text); }
  override async close() { this.status = 'closed'; this.emit('status', this.status); }
}

function fixture(agent = new ModelAgent({} as AgentSession)) {
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = raw => { stdin.isRaw = raw; };
  stdin.ref = () => {}; stdin.unref = () => {};
  let latest = '';
  const frames: { text: string; rows: number }[] = [];
  const stdout = new Writable({ write(chunk, _, done) {
    const text = stripVTControlCharacters(chunk.toString());
    if (text.includes('Enter send') || text.includes('Choose model')) { latest = text; frames.push({ text, rows: stdout.rows! }); }
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 90; stdout.rows = 24;
  const lifetime = new AbortController();
  const running = runLocalTui(agent, [], 'default', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 200) throw new Error(`UI did not update: ${latest}`); await delay(5); } };
  const command = async (text: string) => {
    stdin.write(text); await wait(() => latest.includes(text)); stdin.write('\r');
  };
  return { agent, stdin, stdout, frames, wait, command, get latest() { return latest; }, async close() { lifetime.abort(); await running; assert.equal(stdin.isRaw, false); } };
}

test('the model command opens a real picker, switches after acknowledgment, and supports cancellation and retry', { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    await f.wait(() => f.agent.status === 'ready');
    await f.command('/model');
    await f.wait(() => f.latest.includes('Choose model'));
    assert.ok(f.latest.includes('Default (current)') && f.latest.includes('Sonnet') && f.latest.includes('Use the default model'));
    assert.deepEqual(f.agent.submitted, [], '/model must not be sent as a model prompt');
    f.stdin.write('\x1b[200~sonnet\n\x1b[201~'); await delay(30);
    assert.equal(f.agent.changes.length, 0, 'Paste must not select a model');
    f.stdin.write('\x1b[B'); f.stdin.write('\r');
    await f.wait(() => f.agent.changes.length === 1);
    f.stdin.write('\r'); await delay(30);
    assert.equal(f.agent.changes.length, 1, 'Repeated Enter must not send another change while confirmation is pending');
    assert.equal(f.agent.changes[0]?.value, 'sonnet', 'Rapid arrow + Enter chooses the highlighted row');
    assert.equal(f.agent.model, 'default');
    await f.wait(() => f.latest.includes('Switching model…'));
    f.agent.changes[0]!.resolve();
    await f.wait(() => f.latest.includes('Model changed to Sonnet'));
    assert.ok(f.latest.includes('Ready · sonnet'));

    await f.command('/model');
    await f.wait(() => f.latest.includes('Sonnet (current)'));
    f.stdin.write('\x1b[B'); f.stdin.write('\x1b');
    await f.wait(() => !f.latest.includes('Choose model'));
    assert.equal(f.agent.changes.length, 1);
    assert.equal(f.agent.model, 'sonnet');

    await f.command('/model');
    await f.wait(() => f.latest.includes('Choose model'));
    f.stdin.write('\x1b[B'); f.stdin.write('\r');
    await f.wait(() => f.agent.changes.length === 2);
    f.agent.changes[1]!.reject(new Error('Unavailable for this account'));
    await f.wait(() => f.latest.includes('Unavailable for this account'));
    assert.ok(f.latest.includes('Choose model'));
    assert.equal(f.agent.model, 'sonnet', 'A rejected change must preserve the previous model');
    f.stdout.columns = 50; f.stdout.rows = 16; f.stdout.emit('resize'); await delay(80);
    for (let i = 0; i < 7; i++) f.stdin.write('\x1b[B');
    await f.wait(() => f.latest.includes('Custom 6'));
    for (const frame of f.frames) assert.ok(frame.text.trimEnd().split('\n').length < frame.rows, `Model picker overflowed: ${frame.text}`);
    f.stdin.write('\x1b'); await f.wait(() => !f.latest.includes('Choose model'));

    f.stdout.columns = 90; f.stdout.rows = 24; f.stdout.emit('resize'); await delay(40);
    await f.command('/model provider.custom-model');
    await f.wait(() => f.agent.changes.length === 3);
    assert.equal(f.agent.changes[2]?.value, 'provider.custom-model');
    f.agent.changes[2]!.resolve();
    await f.wait(() => f.latest.includes('Model changed to provider.custom-model'));
    assert.deepEqual(f.agent.submitted, []);
    await f.command('Continue the conversation');
    await f.wait(() => f.agent.submitted.length === 1);
    assert.deepEqual(f.agent.submitted, ['Continue the conversation']);
    assert.equal(f.agent.starts, 1, 'Choosing a model must keep the existing conversation process');
  } finally { await f.close(); }
});

test('a missing model catalog explains the direct command without submitting a prompt', { timeout: 5000 }, async () => {
  const agent = new ModelAgent({} as AgentSession); agent.models = [];
  const f = fixture(agent);
  try {
    await f.wait(() => agent.status === 'ready');
    await f.command('/model');
    await f.wait(() => f.latest.includes('Claude did not provide a model list'));
    assert.equal(f.latest.includes('Choose model'), false);
    assert.deepEqual(agent.submitted, []);
  } finally { await f.close(); }
});
