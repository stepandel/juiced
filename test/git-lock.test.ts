import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { acquireCheckout, CheckoutBusy } from '../src/runtime/project-state.js';

test('independent runtime processes share checkout ownership through SQL', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'juiced-lock-test-'));
  const url = `file:${join(root, 'db')}`;
  const db = createClient({ url });
  await db.execute('PRAGMA journal_mode=WAL');
  const children: ReturnType<typeof spawn>[] = [];
  const diagnostics: string[] = [];
  t.after(async () => { for (const child of children) child.kill(); db.close(); await rm(root, { recursive: true, force: true }); });
  for (const session of ['one', 'two']) {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/git-lease.ts', import.meta.url)), url, session], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    child.stderr!.on('data', bytes => diagnostics.push(bytes.toString()));
    const [ready] = await once(child.stdout!, 'data'); assert.match(String(ready), /READY/);
  }
  assert.equal((await db.execute('SELECT * FROM juiced_checkout_leases')).rows.length, 2);
  await assert.rejects(acquireCheckout(db, 'shared', 'maintenance', 'maintenance', () => {}), CheckoutBusy);
  const closed = children.map(child => once(child, 'close'));
  for (const child of children) child.stdin!.end();
  for (const result of await Promise.all(closed)) assert.equal(result[0], 0, diagnostics.join(''));
  assert.equal((await db.execute('SELECT * FROM juiced_checkout_leases')).rows.length, 0, JSON.stringify((await db.execute('SELECT * FROM juiced_checkout_leases')).rows) + diagnostics.join(''));
  const lease = await acquireCheckout(db, 'shared', 'maintenance', 'maintenance', () => {});
  await lease.release();
});
