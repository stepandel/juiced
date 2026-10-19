import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CantelopClient, type Workspace, type WorkspaceSelector } from '@cantelop/sdk';
import { deleteWorkspace } from '../src/delete-workspace.js';

const id = `wsp_${'a'.repeat(32)}`;
const existing = { id, slug: 'chosen' } as Workspace;
function fixture(workspace: Workspace | undefined = existing, answer?: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: answer !== undefined });
  const stderr = Object.assign(new PassThrough(), { isTTY: answer !== undefined });
  let output = '';
  stderr.on('data', data => {
    output += String(data);
    if (answer !== undefined && output.includes('Type chosen to delete:')) {
      const value = answer; answer = undefined;
      setImmediate(() => stdin.write(`${value}\n`));
    }
  });
  const calls: { operation: string; selector: WorkspaceSelector }[] = [];
  const app = { name: 'juiced', workspace: (selector: WorkspaceSelector) => ({
    async inspect() { calls.push({ operation: 'inspect', selector }); return workspace; },
    async delete() { calls.push({ operation: 'delete', selector }); return { id, status: 'deleting' as const, hostArchived: false }; },
  }) };
  return { io: { stdin, stderr }, app, calls, output: () => output };
}

test('deletes the inspected canonical ID using only SDK workspace methods', async () => {
  const f = fixture();
  await deleteWorkspace(f.app, 'chosen', true, new AbortController().signal, f.io);
  assert.deepEqual(f.calls, [
    { operation: 'inspect', selector: { slug: 'chosen' } },
    { operation: 'delete', selector: { id } },
  ]);
  assert.match(f.output(), /including other project folders/);
  assert.match(f.output(), /Local files and imported Git refs will be kept/);
  assert.match(f.output(), /purge is asynchronous/);
});

test('an absent workspace is a no-op', async () => {
  const f = fixture();
  const app = { ...f.app, workspace: (selector: WorkspaceSelector) => ({ ...f.app.workspace(selector), inspect: async () => undefined }) };
  await deleteWorkspace(app, 'chosen', true, new AbortController().signal, f.io);
  assert.equal(f.calls.length, 0);
  assert.match(f.output(), /does not exist/);
});

test('requires --yes in scripts before accessing Cantelop', async () => {
  const f = fixture();
  await assert.rejects(deleteWorkspace(f.app, 'chosen', false, new AbortController().signal, f.io), /Pass --yes/);
  assert.deepEqual(f.calls, []);
});

test('interactive deletion requires the exact workspace slug', async () => {
  for (const answer of ['yes', 'other', '', 'chosen']) {
    const f = fixture(existing, answer);
    await deleteWorkspace(f.app, 'chosen', false, new AbortController().signal, f.io);
    assert.equal(f.calls.length, answer === 'chosen' ? 2 : 1);
    if (answer !== 'chosen') assert.match(f.output(), /Cancelled/);
  }
});

test('mismatched identities never reach deletion', async () => {
  for (const value of [{ ...existing, id: 'bad' }, { ...existing, slug: 'other' }]) {
    const f = fixture(value);
    await assert.rejects(deleteWorkspace(f.app, 'chosen', true, new AbortController().signal, f.io), /invalid Workspace/);
    assert.equal(f.calls.length, 1);
  }
});

test('abort after lookup prevents deletion, and failed deletion is not reported as success', async () => {
  const controller = new AbortController();
  const f = fixture();
  const stopped = { ...f.app, workspace: (selector: WorkspaceSelector) => ({ ...f.app.workspace(selector), inspect: async () => { controller.abort(new Error('Stopped')); return existing; } }) };
  await assert.rejects(deleteWorkspace(stopped, 'chosen', true, controller.signal, f.io), /Stopped/);
  assert.equal(f.calls.length, 0);
  const failed = { ...f.app, workspace: (selector: WorkspaceSelector) => ({ ...f.app.workspace(selector), delete: async () => { throw new Error('Unavailable'); } }) };
  await assert.rejects(deleteWorkspace(failed, 'chosen', true, new AbortController().signal, f.io), /Unavailable/);
  assert.doesNotMatch(f.output(), /Deletion requested/);
});

test('real SDK transport handles lookup and deletion without a Cantelop CLI or account login', async () => {
  const calls: unknown[] = [];
  const f = fixture();
  const app = new CantelopClient().app({ name: 'juiced', runtime: { receive() {} }, connection: { async fetch(request) {
    const body = await request.json(); calls.push(body);
    assert.equal(new URL(request.url).pathname, `/commands/${body.command.type}`);
    assert.equal(body.session, null);
    if (body.command.type === 'workspace.inspect') {
      return Response.json({ protocolVersion: 2, workspace: { id, app_id: `app_${'b'.repeat(32)}`, slug: 'chosen', hostname: 'chosen.juiced.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' } });
    }
    assert.equal(body.command.type, 'workspace.delete');
    assert.deepEqual(body.workspace, { id });
    return Response.json({ protocolVersion: 2, id, status: 'deleting', hostArchived: true }, { status: 202 });
  } } });
  await deleteWorkspace(app, 'chosen', true, new AbortController().signal, f.io);
  assert.equal(calls.length, 2);
  assert.match(f.output(), /Deletion requested/);
});
