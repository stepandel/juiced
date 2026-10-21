import { setTimeout as delay } from 'node:timers/promises';
import { services } from './main.js';
import { Provisioner } from './provisioning.js';
import { UsageIngestor } from './usage.js';
import { TerminalCloser } from './terminals.js';
import { enqueue } from './accounts.js';
import { transaction } from './db.js';
const s = services(process.env, 'worker'),
  cancel = new AbortController();
process.once('SIGINT', () => cancel.abort());
process.once('SIGTERM', () => cancel.abort());
const terminals = new TerminalCloser(s.pool, s.platform);
const provisioner = new Provisioner(s.pool, s.accounts, s.platform, s.billing),
  usage = new UsageIngestor(s.pool, s.platform);
async function loop(name: string, run: () => Promise<boolean>, idle: number) {
  while (!cancel.signal.aborted) {
    let worked = false;
    try {
      worked = await run();
    } catch {
      process.stderr.write(JSON.stringify({ worker: name, error: 'retry_pending' }) + '\n');
    }
    await delay(worked ? 50 : idle, undefined, { signal: cancel.signal }).catch(() => {});
  }
}
try {
  await s.billing.check();
  await Promise.all([
    loop('provision', () => provisioner.runOnce(), 1000),
    loop('billing', () => s.billing.runOnce(), 3000),
    loop('usage', () => usage.runOnce(), 5000),
    loop('terminals', () => terminals.runOnce(), 2000),
    loop(
      'expiry',
      () =>
        transaction(s.pool, async (tx) => {
          const rows = await tx.query(
            `UPDATE accounts SET entitlement='inactive' WHERE entitlement='active' AND period_end<=now() RETURNING id,period_id`,
          );
          for (const a of rows.rows)
            await enqueue(tx, String(a.id), 'suspend', {}, `expired:${a.id}:${a.period_id}`);
          return false;
        }),
      5000,
    ),
  ]);
} finally {
  await s.pool.end();
}
