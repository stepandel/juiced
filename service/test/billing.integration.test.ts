import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { testDatabase, user } from './database.js';
import { Accounts } from '../src/accounts.js';
import { Billing } from '../src/billing.js';

test(
  'signed billing inbox reconciles authoritative paid invoices once, including replay and renewal',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const fixture = await testDatabase(),
      { pool } = fixture;
    try {
      const accounts = new Accounts(pool, {
          packageId: 'pkg_' + 'a'.repeat(32),
          runtimeId: 'runtime-v1',
          minimumCli: '0.2.0',
        }),
        a = await accounts.ensure(await user(pool));
      const start = Math.floor(Date.now() / 1000) - 60,
        end = start + 30 * 86400,
        customer = 'cus_test',
        price = 'price_test';
      let subscription = {
        id: 'sub_test',
        customer,
        status: 'active',
        created: start,
        metadata: { juiced_account: a.id },
        items: {
          data: [
            {
              price: { id: price },
              quantity: 1,
              current_period_start: start,
              current_period_end: end,
            },
          ],
        },
        latest_invoice: 'in_test1',
      };
      let invoice = {
        id: 'in_test1',
        customer,
        status: 'paid',
        parent: { subscription_details: { subscription: 'sub_test' } },
        lines: { data: [{ pricing: { price_details: { price } }, period: { start, end } }] },
      };
      const signing = new Stripe('sk_test_example'),
        fake = {
          webhooks: signing.webhooks,
          subscriptions: {
            async list() {
              return { data: [subscription], has_more: false };
            },
          },
          invoices: {
            async retrieve() {
              return invoice;
            },
          },
        } as unknown as Stripe;
      const billing = new Billing(pool, fake, {
        price,
        credits: 1000000,
        webhookSecret: 'whsec_test',
        origin: 'https://juiced.example',
      });
      await pool.query('INSERT INTO subscriptions(account_id,customer_id) VALUES($1,$2)', [
        a.id,
        customer,
      ]);
      const event = async (id: string) => {
        const body = JSON.stringify({
          id,
          type: 'invoice.paid',
          livemode: false,
          data: { object: { customer } },
        });
        const signature = signing.webhooks.generateTestHeaderString({
          payload: body,
          secret: 'whsec_test',
        });
        return billing.webhook(
          new Request('https://juiced.example/webhooks/stripe', {
            method: 'POST',
            headers: { 'stripe-signature': signature },
            body,
          }),
        );
      };
      await assert.rejects(
        billing.webhook(
          new Request('https://juiced.example/webhooks/stripe', { method: 'POST', body: '{}' }),
        ),
        { code: 'invalid_webhook' },
      );
      await Promise.all([event('evt_initial'), event('evt_initial')]);
      assert.equal((await pool.query('SELECT count(*) FROM billing_events')).rows[0].count, '1');
      await billing.runOnce();
      let state = (await pool.query('SELECT * FROM accounts WHERE id=$1', [a.id])).rows[0];
      assert.equal(state.entitlement, 'active');
      assert.equal(state.period_id, 'in_test1');
      await accounts.bootstrap(state, { version: '0.2.0', runtimeId: 'runtime-v1' });
      await pool.query("UPDATE accounts SET entitlement='exhausted' WHERE id=$1", [a.id]);
      await event('evt_replayed');
      await billing.runOnce();
      assert.equal(
        (await pool.query('SELECT entitlement FROM accounts WHERE id=$1', [a.id])).rows[0]
          .entitlement,
        'exhausted',
      );
      subscription = {
        ...subscription,
        latest_invoice: 'in_test2',
        items: {
          data: [
            {
              ...subscription.items.data[0]!,
              current_period_start: end,
              current_period_end: end + 30 * 86400,
            },
          ],
        },
      };
      invoice = {
        ...invoice,
        id: 'in_test2',
        lines: {
          data: [
            {
              pricing: { price_details: { price } },
              period: { start: end, end: end + 30 * 86400 },
            },
          ],
        },
      };
      await event('evt_renewal');
      await billing.runOnce();
      state = (await pool.query('SELECT * FROM accounts WHERE id=$1', [a.id])).rows[0];
      assert.equal(state.entitlement, 'active');
      assert.equal(state.period_id, 'in_test2');
      assert.equal(
        (await pool.query('SELECT count(*) FROM entitlement_grants')).rows[0].count,
        '2',
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM jobs WHERE idempotency_key LIKE 'renew:%'")).rows[0]
          .count,
        '1',
      );
      subscription = { ...subscription, status: 'canceled' };
      await event('evt_cancel');
      await billing.runOnce();
      assert.equal(
        (await pool.query('SELECT entitlement FROM accounts WHERE id=$1', [a.id])).rows[0]
          .entitlement,
        'inactive',
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  'account cancellation expires a recovered checkout and cancels an unobserved subscription',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await testDatabase();
    try {
      const accounts = new Accounts(f.pool, {
          packageId: 'pkg_' + 'a'.repeat(32),
          runtimeId: 'runtime-1',
          minimumCli: '0.2.0',
        }),
        a = await accounts.ensure(await user(f.pool));
      await f.pool.query('INSERT INTO subscriptions(account_id,customer_id) VALUES($1,$2)', [
        a.id,
        'cus_delete',
      ]);
      await f.pool.query(
        `INSERT INTO checkout_sessions(account_id,intent_id,expires_at) VALUES($1,'checkout-durable-intent',now()+interval '31 minutes')`,
        [a.id],
      );
      const calls: string[] = [];
      const fake = {
        checkout: {
          sessions: {
            async create(_input: unknown, options: { idempotencyKey: string }) {
              calls.push(options.idempotencyKey);
              return { id: 'cs_ambiguous', status: 'open' };
            },
            async expire(id: string) {
              calls.push('expire:' + id);
            },
          },
        },
        subscriptions: {
          async list() {
            return {
              data: [
                {
                  id: 'sub_paid_before_webhook',
                  status: 'active',
                  metadata: { juiced_account: a.id },
                },
              ],
              has_more: false,
            };
          },
          async cancel(id: string) {
            calls.push('cancel:' + id);
          },
        },
      } as unknown as Stripe;
      const billing = new Billing(f.pool, fake, {
        price: 'price_test',
        credits: 100000,
        webhookSecret: 'whsec_test',
        origin: 'https://juiced.example',
      });
      await billing.cancel(a);
      assert.deepEqual(calls, [
        'checkout-durable-intent',
        'expire:cs_ambiguous',
        'cancel:sub_paid_before_webhook',
      ]);
    } finally {
      await f.close();
    }
  },
);
