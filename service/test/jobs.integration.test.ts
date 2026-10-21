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
