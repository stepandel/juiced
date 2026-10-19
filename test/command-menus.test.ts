import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import type { ClaudeFrame } from '../src/agent-protocol.js';
import { RemoteAgent, type AgentSession, type MenuChange, type MenuQuery } from '../src/remote-agent.js';
import { commandMenu, menuCommand, menuCommands } from '../src/tui/command-menus.js';
import { availableCommands } from '../src/tui/commands.js';
import type { MenuPage, MenuResult } from '../src/tui/menu.js';
import { runLocalTui } from '../src/tui/app.js';
import type { TerminalInput, TerminalOutput } from '../src/remote-terminal.js';

class MenuAgent extends RemoteAgent {
  queries: MenuQuery[] = [];
  changes: MenuChange[] = [];
  submitted: string[] = [];
  settings = { effective: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo finished' }] }] }, permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, env: { SECRET_KEY: 'must-not-appear' } }, sources: [], applied: { effort: 'medium' } };
  responses: Record<string, ClaudeFrame | Error> = {
    mcp_status: { mcpServers: [{ name: 'remote-docs', status: 'connected', tools: [{ name: 'search' }] }] },
    get_hooks_listing: new Error('Unsupported control request subtype: get_hooks_listing'),
    get_usage: new Error('Unsupported control request subtype: get_usage'),
    get_session_cost: { text: 'Total cost: $0.12\nUsage: 120 input, 40 output' },
    get_context_usage: { categories: [{ name: 'Messages', tokens: 123 }], totalTokens: 123, maxTokens: 200000, percentage: 0.06, memoryFiles: [{ path: '/workspace/CLAUDE.md', tokens: 30, type: 'project' }] },
    read_file: { contents: 'Project instructions\nRun the tests' },
  };
  waitForQuery: ((query: MenuQuery) => Promise<ClaudeFrame>) | undefined;
  waitForChange: ((change: MenuChange) => Promise<ClaudeFrame>) | undefined;
  permissionAnswer: ((allow: boolean) => void) | undefined;
  override async start() {
    this.models = [{ value: 'provider-x', displayName: 'Provider X', description: 'Remote model', supportedEffortLevels: ['low', 'high'] }];
    this.model = 'provider-x';
    this.info = { current_permission_mode: 'default', output_style: 'Provider style', available_output_styles: ['Provider style', 'Workspace style'], agents: [{ name: 'Workspace reviewer', description: 'A custom agent' }], fast_mode_state: 'off', fast_mode_disabled_reason: 'account_disabled' };
    this.commands = [{ name: 'project:review', description: 'Review project changes', argumentHint: '[scope]' }];
    this.status = 'ready'; this.emit('models', this.models); this.emit('model', this.model); this.emit('commands', this.commands); this.emit('status', this.status);
  }
  override async query(query: MenuQuery): Promise<ClaudeFrame> {
    this.queries.push(query);
    if (this.waitForQuery) return this.waitForQuery(query);
    if (query.subtype === 'get_settings') return this.settings;
    const response = this.responses[query.subtype] ?? {};
    if (response instanceof Error) throw response;
    return response;
  }
  override async configure(change: MenuChange): Promise<ClaudeFrame> {
    this.changes.push(change);
    this.status = 'configuring'; this.emit('status', this.status);
    try { return await this.waitForChange?.(change) ?? {}; }
    finally { this.status = 'ready'; this.emit('status', this.status); }
  }
  override async submit(text: string) { this.submitted.push(text); }
  override async answer(id: string, allow: boolean) { this.approvals.delete(id); this.emit('approvals'); this.permissionAnswer?.(allow); }
  override async close() { this.status = 'closed'; this.emit('status', this.status); }
}

function page(result: MenuResult): MenuPage { assert.ok(result && 'title' in result); return result; }
async function choose(menu: MenuPage, id: string): Promise<MenuResult> {
  const item = menu.items.find(item => item.id === id); assert.ok(item?.run); return item.run();
}
const agent = async () => { const agent = new MenuAgent({ id: 'menu-session' } as AgentSession); await agent.start(); return agent; };

test('menu registry covers command families and aliases without treating project skills as UI commands', () => {
  for (const command of [...menuCommands, { name: 'model' }, { name: 'help' }]) assert.ok(menuCommand(`/${command.name}`));
  assert.deepEqual(menuCommand('/settings'), { name: 'config', argument: '' });
  assert.deepEqual(menuCommand('/cost'), { name: 'usage', argument: '' });
  assert.equal(menuCommand('/project:review'), undefined);
  assert.equal(menuCommand('ordinary prompt /model'), undefined);
  assert.ok(menuCommand('/resume'));
  for (const command of menuCommands) assert.ok(availableCommands([]).some(item => item.name === command.name));
});

test('effort and output style choices use provider metadata and change only after selection', async () => {
  const a = await agent();
  const effort = await commandMenu(a, 'effort');
  assert.deepEqual(effort.items.map(item => item.id), ['low', 'high']);
  assert.deepEqual(a.changes, []);
  await choose(effort, 'high');
  assert.deepEqual(a.changes, [{ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }]);
  const styles = await commandMenu(a, 'output-style');
  assert.deepEqual(styles.items.map(item => item.id), ['Provider style', 'Workspace style']);
  await choose(styles, 'Workspace style');
  assert.deepEqual(a.changes.at(-1), { subtype: 'apply_flag_settings', settings: { outputStyle: 'Workspace style' } });
  await assert.rejects(commandMenu(a, 'effort', 'invented'), /Claude offers/);
  a.models = [];
  assert.deepEqual((await commandMenu(a, 'effort')).items, [], 'No fabricated effort catalog when metadata is absent');
  assert.deepEqual(a.submitted, []);
});

test('settings redact credentials and permission changes require a deliberate confirmation', async () => {
  const a = await agent();
  const config = await commandMenu(a, 'config');
  const effective = page(await choose(config, 'effective'));
  assert.equal(JSON.stringify(effective).includes('must-not-appear'), false);
  assert.ok(JSON.stringify(effective).includes('[redacted]'));
  const permissions = await commandMenu(a, 'permissions');
  const confirmation = page(await choose(permissions, 'acceptEdits'));
  assert.equal(confirmation.items[0]?.id, 'cancel');
  assert.deepEqual(a.changes, []);
  await choose(confirmation, 'confirm');
  assert.deepEqual(a.changes, [{ subtype: 'set_permission_mode', mode: 'acceptEdits' }]);
  const rules = page(await choose(permissions, 'deny'));
  assert.ok(JSON.stringify(rules).includes('Bash(rm *)'));
  assert.equal(permissions.items.some(item => item.id === 'bypassPermissions'), false);
});

test('MCP server menus use remote names and send one confirmed control operation', async () => {
  const a = await agent();
  const mcp = await commandMenu(a, 'mcp');
  assert.deepEqual(mcp.items.map(item => item.id), ['remote-docs']);
  assert.deepEqual(a.changes, []);
  const server = page(await choose(mcp, 'remote-docs'));
  const disabled = page(await choose(server, 'false'));
  await choose(disabled, 'confirm');
  assert.deepEqual(a.changes, [{ subtype: 'mcp_toggle', serverName: 'remote-docs', enabled: false }]);
  assert.deepEqual(a.queries, [{ subtype: 'mcp_status' }, { subtype: 'mcp_status' }]);
  assert.deepEqual(a.submitted, []);
});

test('read-only menus use summary APIs, fallback on unsupported RPCs, and propagate real errors', async () => {
  const a = await agent();
  assert.equal((await commandMenu(a, 'hooks')).title, 'Configured hooks');
  assert.ok(JSON.stringify(await commandMenu(a, 'usage')).includes('Total cost: $0.12'));
  const memory = await commandMenu(a, 'memory');
  assert.equal(memory.items[0]?.label, '/workspace/CLAUDE.md');
  assert.ok(JSON.stringify(await choose(memory, '0')).includes('Project instructions'));
  assert.ok(a.queries.some(query => query.subtype === 'get_context_usage' && query.detail === 'summary'));
  assert.ok(a.queries.some(query => query.subtype === 'read_file' && query.max_bytes === 32768));
  a.responses.get_hooks_listing = new Error('Permission denied');
  await assert.rejects(commandMenu(a, 'hooks'), /Permission denied/);
  for (const name of ['resume', 'rewind', 'theme', 'terminal-setup']) {
    const unavailable = await commandMenu(a, name);
    assert.equal(unavailable.items.length, 0);
    assert.match(unavailable.footer!, /Unavailable/);
  }
  assert.deepEqual(a.submitted, []);
});

function ui(a: MenuAgent) {
  const stdin = new PassThrough() as PassThrough & TerminalInput & { ref(): void; unref(): void };
  stdin.isTTY = true; stdin.isRaw = false; stdin.setRawMode = raw => { stdin.isRaw = raw; }; stdin.ref = () => {}; stdin.unref = () => {};
  let latest = '';
  const frames: { text: string; rows: number }[] = [];
  const stdout = new Writable({ write(chunk, _, done) {
    const text = stripVTControlCharacters(chunk.toString());
    if (text.includes('Enter send') || text.includes('Enter confirm')) { latest = text; frames.push({ text, rows: stdout.rows! }); }
    done();
  } }) as TerminalOutput;
  stdout.isTTY = true; stdout.columns = 90; stdout.rows = 24;
  const lifetime = new AbortController();
  const running = runLocalTui(a, [], 'test', { stdin, stdout, stderr: new PassThrough() }, lifetime.signal);
  const wait = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 400) throw new Error(`UI did not update: ${latest}`); await delay(5); } };
  const command = async (text: string) => { stdin.write(text); await wait(() => latest.includes(text)); stdin.write('\r'); };
  return { stdin, stdout, frames, wait, command, get latest() { return latest; }, async close() { lifetime.abort(); await running; assert.equal(stdin.isRaw, false); } };
}

test('settings and nested menus navigate locally, reject paste confirmation, and recover from a failed change', { timeout: 10000 }, async () => {
  const a = await agent();
  const f = ui(a);
  try {
    await f.wait(() => f.latest.includes('Enter send'));
    await f.command('/config'); await f.wait(() => f.latest.includes('Workspace settings'));
    assert.equal(a.queries.length, 1);
    f.stdin.write('output'); await f.wait(() => f.latest.includes('Filter: output'));
    assert.equal(a.queries.length, 1, 'Filtering must not send remote requests');
    f.stdin.write('\r'); await f.wait(() => f.latest.includes('Choose output style'));
    assert.equal(a.queries.length, 1, 'Known catalogs need no round trip when opening a picker');
    f.stdin.write('\x1b'); await f.wait(() => f.latest.includes('Workspace settings'));
    assert.equal(a.queries.length, 1, 'Back uses the local page snapshot');
    f.stdin.write('\x1b'); await f.wait(() => !f.latest.includes('Filter: output'));
    f.stdin.write('\x1b'); await f.wait(() => f.latest.includes('Enter send'));
    await f.command('/effort'); await f.wait(() => f.latest.includes('Choose effort'));
    const requests = a.queries.length;
    f.stdin.write('\x1b[200~high\n\x1b[201~'); await delay(30);
    assert.equal(a.changes.length, 0, 'Pasting must not commit a setting');
    assert.equal(a.queries.length, requests);
    let reject!: (error: Error) => void;
    a.waitForChange = () => new Promise((_, no) => { reject = no; });
    f.stdin.write('\r'); await f.wait(() => a.changes.length === 1);
    f.stdin.write('\r'); await delay(30);
    assert.equal(a.changes.length, 1, 'Repeated Enter sends a single operation');
    reject(new Error('Account policy rejected this setting'));
    await f.wait(() => f.latest.includes('Account policy rejected'));
    assert.ok(f.latest.includes('Choose effort'));
    a.waitForChange = undefined;
    f.stdin.write('\r'); await f.wait(() => f.latest.includes('Effort changed to high'));
    assert.equal(a.changes.length, 2);
    assert.deepEqual(a.submitted, []);
  } finally { await f.close(); }
});

test('a slow menu read can be cancelled and cannot reopen over a local draft', { timeout: 10000 }, async () => {
  const a = await agent();
  let resolve!: (value: ClaudeFrame) => void;
  a.waitForQuery = () => new Promise(yes => { resolve = yes; });
  const f = ui(a);
  try {
    await f.wait(() => f.latest.includes('Enter send'));
    await f.command('/mcp'); await f.wait(() => f.latest.includes('Loading menu'));
    f.stdin.write('\x1b'); await f.wait(() => f.latest.includes('Enter send'));
    f.stdin.write('Keep typing locally'); await f.wait(() => f.latest.includes('Keep typing locally'));
    resolve({ mcpServers: [{ name: 'too-late', status: 'connected' }] }); await delay(40);
    assert.ok(f.latest.includes('Keep typing locally'));
    assert.equal(f.latest.includes('MCP servers'), false);
    assert.deepEqual(a.submitted, []);
  } finally { await f.close(); }
});

test('MCP menu filtering and resizing stay within the viewport without remote key forwarding', { timeout: 10000 }, async () => {
  const a = await agent();
  a.responses.mcp_status = { mcpServers: Array.from({ length: 20 }, (_, index) => ({ name: `server-${index}`, status: 'connected' })) };
  const f = ui(a);
  try {
    await f.wait(() => f.latest.includes('Enter send'));
    await f.command('/mcp'); await f.wait(() => f.latest.includes('MCP servers'));
    f.stdout.columns = 42; f.stdout.rows = 15; f.stdout.emit('resize'); await delay(30);
    for (let index = 0; index < 18; index++) f.stdin.write('\x1b[B');
    await f.wait(() => f.latest.includes('server-18'));
    f.stdin.write('19'); await f.wait(() => f.latest.includes('Filter: 19'));
    assert.equal(a.queries.length, 1);
    assert.deepEqual(a.changes, []);
    for (const frame of f.frames) assert.ok(frame.text.trimEnd().split('\n').length < frame.rows, `Menu overflowed: ${frame.text}`);
  } finally { await f.close(); }
});

test('a memory read can ask permission without losing the open menu or consuming permission keys', { timeout: 10000 }, async () => {
  const a = await agent();
  a.waitForQuery = async query => {
    if (query.subtype === 'get_context_usage') return a.responses.get_context_usage as ClaudeFrame;
    assert.equal(query.subtype, 'read_file');
    return new Promise((resolve, reject) => {
      a.permissionAnswer = allow => allow ? resolve({ contents: 'Permission-checked memory contents' }) : reject(new Error('Read declined'));
      a.approvals.set('read-memory', { id: 'read-memory', tool: 'Read', input: { file_path: '/workspace/CLAUDE.md' }, description: 'Read the selected memory file' });
      a.emit('approvals');
    });
  };
  const f = ui(a);
  try {
    await f.wait(() => f.latest.includes('Enter send'));
    await f.command('/memory'); await f.wait(() => f.latest.includes('Loaded memory files'));
    f.stdin.write('\r');
    // Permission frames use a different footer, so inspect the agent's active
    // request here. After approval the same menu instance must show the result.
    await f.wait(() => a.approvals.size === 1); await delay(30);
    f.stdin.write('y');
    await f.wait(() => f.latest.includes('Permission-checked memory contents'));
    assert.equal(a.queries.filter(query => query.subtype === 'read_file').length, 1);
    assert.equal(f.latest.includes('Filter: y'), false, 'Permission keys must not edit the hidden menu');
    assert.deepEqual(a.submitted, []);
  } finally { await f.close(); }
});
