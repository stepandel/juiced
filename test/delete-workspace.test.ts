import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { deleteWorkspace } from '../src/delete-workspace.js';

const id = `wsp_${'a'.repeat(32)}`;
const appId = `app_${'b'.repeat(32)}`;
const page = { items: [{ id, app_id: appId, slug: 'chosen' }] };
function fixture(items: unknown = page, answer?: string) {
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
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify(args[1] === 'list' ? items : { id, status: 'deleting' });
  };
  return { io: { stdin, stderr }, run, calls, output: () => output };
}

test('deletes only the selected canonical workspace ID, without resolving or creating it', async () => {
  const f = fixture({ items: [...page.items, { id: `wsp_${'c'.repeat(32)}`, app_id: appId, slug: 'other' }] });
  await deleteWorkspace('juiced', 'chosen', true, new AbortController().signal, f.io, f.run);
  assert.deepEqual(f.calls, [
    ['workspace', 'list', '--app', 'juiced', '--json'],
    ['workspace', 'delete', id, '--yes', '--json'],
  ]);
  assert.match(f.output(), /including other project folders/);
  assert.match(f.output(), /Local files and imported Git refs will be kept/);
  assert.match(f.output(), /purge is asynchronous/);
});

test('an absent or archived workspace is a no-op', async () => {
  for (const items of [{ items: [] }, { items: [{ ...page.items[0], archived_at: '2026-10-19' }] }]) {
    const f = fixture(items);
    await deleteWorkspace('juiced', 'chosen', true, new AbortController().signal, f.io, f.run);
    assert.equal(f.calls.length, 1);
    assert.match(f.output(), /does not exist/);
  }
});

test('requires --yes in scripts before accessing Cantelop', async () => {
  const f = fixture();
  await assert.rejects(deleteWorkspace('juiced', 'chosen', false, new AbortController().signal, f.io, f.run), /Pass --yes/);
  assert.deepEqual(f.calls, []);
});

test('interactive deletion requires the exact workspace slug', async () => {
  for (const answer of ['yes', 'other', '', 'chosen']) {
    const f = fixture(page, answer);
    await deleteWorkspace('juiced', 'chosen', false, new AbortController().signal, f.io, f.run);
    assert.equal(f.calls.length, answer === 'chosen' ? 2 : 1);
    if (answer !== 'chosen') assert.match(f.output(), /Cancelled/);
  }
});

test('invalid or ambiguous workspace identities never reach deletion', async () => {
  for (const value of [{}, { items: {} }, { items: [{ ...page.items[0], id: 'bad' }] }, { items: [page.items[0], page.items[0]] }]) {
    const f = fixture(value);
    await assert.rejects(deleteWorkspace('juiced', 'chosen', true, new AbortController().signal, f.io, f.run), /invalid Workspace/);
    assert.equal(f.calls.length, 1);
  }
});

test('abort after lookup prevents deletion, and failed deletion is not reported as success', async () => {
  const controller = new AbortController();
  const f = fixture();
  await assert.rejects(deleteWorkspace('juiced', 'chosen', true, controller.signal, f.io, async args => {
    const result = await f.run(args); controller.abort(new Error('Stopped')); return result;
  }), /Stopped/);
  assert.equal(f.calls.length, 1);
  const failed = fixture();
  await assert.rejects(deleteWorkspace('juiced', 'chosen', true, new AbortController().signal, failed.io, async args => {
    if (args[1] === 'delete') throw new Error('Unavailable');
    return failed.run(args);
  }), /Unavailable/);
  assert.doesNotMatch(failed.output(), /Deletion requested/);
});
