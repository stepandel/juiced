import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { testDatabase, user } from './database';
import { Accounts, enqueue } from '../src/accounts';
import { reconcile } from '../src/jobs';
import { application } from '../src/app';
import { Billing } from '../src/billing';
import { config } from '../src/config';
import { authentication } from '../src/auth';
import type { Platform } from '../src/platform';

async function fixture() {
  const f = await testDatabase();
  const accounts = new Accounts(f.pool, {
    packageId: 'pkg_test',
    runtimeId: 'runtime-test',
    minimumCli: '0.2.0',
  });
  const cancelled: string[] = [];
  const platform = {
    async request(method: string, path: string) {
      assert.equal(method, 'GET');
      assert.equal(path, 'usage?after=0');
      return { items: [], after: '0' };
    },
  } as unknown as Platform;
  const billing = {
    async runOnce() {
      return false;
    },
    async cancel(a: { id: string }) {
      cancelled.push(a.id);
    },
  };
  return { ...f, accounts, platform, billing, cancelled };
}

test(
  'cron recovery and duplicate queue deliveries finish a durable deletion once without touching another account',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    try {
      const account = await f.accounts.ensure(await user(f.pool));
      const other = await f.accounts.ensure(await user(f.pool));
      await f.pool.query("UPDATE accounts SET status='deleting' WHERE id=$1", [account.id]);
      // This committed intent deliberately has no queue message: cron must recover it.
      await enqueue(f.pool, account.id, 'delete', {}, `delete:${account.id}`);
      await Promise.all([reconcile(f, async () => {}), reconcile(f, async () => {})]);
      await reconcile(f, async () => {});
      assert.deepEqual(f.cancelled, [account.id]);
      assert.equal(
        (await f.pool.query('SELECT status FROM accounts WHERE id=$1', [account.id])).rows[0]!
          .status,
        'deleted',
      );
      assert.equal(
        (await f.pool.query('SELECT status FROM accounts WHERE id=$1', [other.id])).rows[0]!.status,
        'active',
      );
      assert.equal((await f.pool.query('SELECT status FROM jobs')).rows[0]!.status, 'done');
    } finally {
      await f.close();
    }
  },
);

test(
  'an unmapped usage event preserves its cursor while other jobs drain and schedule their next retry',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture();
    try {
      const accounts = await Promise.all(
        Array.from({ length: 3 }, async () => f.accounts.ensure(await user(f.pool))),
      );
      for (const a of accounts) {
        await f.pool.query("UPDATE accounts SET status='deleting' WHERE id=$1", [a.id]);
        await enqueue(f.pool, a.id, 'delete', {}, `delete:${a.id}`);
      }
      const future = await f.accounts.ensure(await user(f.pool));
      await f.pool.query(
        `INSERT INTO installations(id,account_id,external_key,package_id,runtime_id,status,app_id)
        VALUES('jin_mapped',$1,'installation-mapped','pkg_test','runtime-test','pending','app_mapped')`,
        [future.id],
      );
      await enqueue(f.pool, future.id, 'provision', {}, `provision:${future.id}`);
      await f.pool.query(
        "UPDATE jobs SET available_at=now()+interval '3 seconds' WHERE account_id=$1",
        [future.id],
      );
      await f.pool.query("INSERT INTO settings(key,value) VALUES('usage_cursor','0')");
      let reads = 0;
      f.platform.request = async <T>() => {
        reads++;
        return {
          items: [
            { id: 'known-usage', sequence: '1', app_id: 'app_mapped', credits: '1', epoch: future.period_id },
            { id: 'unknown-usage', sequence: '2', app_id: 'app_unmapped', credits: '42', epoch: 'free' },
          ],
          after: '2',
        } as T;
      };
      const errors = t.mock.method(console, 'error', () => {});
      const delays: number[] = [];
      await reconcile(f, async (delay) => { delays.push(delay ?? 0); });
      const error = JSON.parse(errors.mock.calls[0]!.arguments[0] as string);
      assert.equal(error.error, 'usage_app_unmapped: app=app_unmapped sequence=2');
      assert.equal(error.worker, 'usage');
      assert.equal(reads, 1, 'a failed worker waits for a new delivery instead of spinning');
      assert.deepEqual([...f.cancelled].sort(), accounts.map(a => a.id).sort());
      assert.equal(
        (await f.pool.query("SELECT count(*)::int AS n FROM jobs WHERE status='done'")).rows[0]!.n,
        3,
      );
      assert.equal(
        (await f.pool.query('SELECT status FROM jobs WHERE account_id=$1', [future.id])).rows[0]!.status,
        'pending',
      );
      assert.equal(
        (await f.pool.query("SELECT value FROM settings WHERE key='usage_cursor'")).rows[0]!.value,
        '0',
      );
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM usage_events')).rows[0]!.n, 0);
      assert.equal(delays.length, 1);
      assert.ok(delays[0]! >= 1 && delays[0]! <= 3);
      await f.pool.query("UPDATE jobs SET status='done' WHERE account_id=$1", [future.id]);
      await reconcile(f, async (delay) => { delays.push(delay ?? 0); });
      assert.equal(reads, 2, 'the next delivery retries the blocked usage page');
      assert.deepEqual(delays.slice(1), [10], 'the failed worker schedules one retry even without other work');
      await assert.rejects(reconcile(f, async () => { throw new Error('queue unavailable'); }), /queue unavailable/);
    } finally {
      await f.close();
    }
  },
);

test(
  'future database retries schedule a delayed wake-up and survive a failed publish',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    try {
      const account = await f.accounts.ensure(await user(f.pool));
      await f.pool.query("UPDATE accounts SET status='deleting' WHERE id=$1", [account.id]);
      await enqueue(f.pool, account.id, 'delete', {}, `delete:${account.id}`);
      await f.pool.query("UPDATE jobs SET available_at=now()+interval '10 seconds'");
      const delays: number[] = [];
      await reconcile(f, async (delay) => {
        delays.push(delay ?? 0);
      });
      assert.equal(f.cancelled.length, 0);
      assert.equal(delays.length, 1);
      assert.ok(delays[0]! >= 1 && delays[0]! <= 10);
      await assert.rejects(
        reconcile(f, async () => {
          throw new Error('queue unavailable');
        }),
        /queue unavailable/,
      );
      assert.equal((await f.pool.query('SELECT status FROM jobs')).rows[0]!.status, 'pending');
      await f.pool.query('UPDATE jobs SET available_at=now()');
      await reconcile(f, async () => {});
      assert.deepEqual(f.cancelled, [account.id]);
    } finally {
      await f.close();
    }
  },
);

test(
  'a signed Stripe event stays durable when queue publication fails and its retry is deduplicated',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    try {
      const cfg = config({
        NODE_ENV: 'test',
        JUICED_SERVICE_URL: 'http://127.0.0.1:3000',
        JUICED_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters',
        JUICED_DATABASE_URL: process.env.JUICED_TEST_DATABASE_URL,
      });
      const stripe = new Stripe('sk_test_fixture');
      const secret = 'whsec_test';
      const billing = new Billing(f.pool, stripe, {
        price: 'price_test',
        credits: 100,
        webhookSecret: secret,
        origin: cfg.origin,
      });
      const auth = authentication(f.pool, cfg);
      await auth.$context;
      const body = JSON.stringify({
        id: 'evt_retry',
        object: 'event',
        type: 'invoice.paid',
        livemode: false,
        data: { object: { customer: 'cus_test' } },
      });
      const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret });
      let unavailable = true,
        published = 0;
      const handle = application({
        ...f,
        cfg,
        auth,
        billing,
        wake: async () => {
          if (unavailable) throw new Error('queue unavailable');
          published++;
        },
      });
      const request = () =>
        new Request(`${cfg.origin}/webhooks/stripe`, {
          method: 'POST',
          headers: { 'stripe-signature': signature },
          body,
        });
      assert.equal((await handle(request())).status, 503);
      assert.equal(
        (await f.pool.query('SELECT count(*)::int AS n FROM billing_events')).rows[0]!.n,
        1,
      );
      unavailable = false;
      assert.equal((await handle(request())).status, 200);
      assert.equal(published, 1);
      assert.equal(
        (await f.pool.query('SELECT count(*)::int AS n FROM billing_events')).rows[0]!.n,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
