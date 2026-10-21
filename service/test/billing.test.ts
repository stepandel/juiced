import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { Billing } from '../src/billing';

test('billing verifies Stripe once and retries a failed check on the next call', async () => {
  let calls = 0;
  const fake = {
    prices: {
      async retrieve() {
        if (++calls === 1) throw new Error('stripe unavailable');
        return {
          active: true,
          type: 'recurring',
          recurring: { usage_type: 'licensed' },
          billing_scheme: 'per_unit',
          unit_amount: 2000,
          livemode: false,
        };
      },
    },
  } as unknown as Stripe;
  const billing = new Billing({} as Pool, fake, {
    price: 'price_test',
    credits: 100000,
    webhookSecret: 'whsec_test',
    origin: 'https://juiced.example',
  });
  await assert.rejects(billing.ready(), /stripe unavailable/);
  await Promise.all([billing.ready(), billing.ready()]);
  await billing.ready();
  assert.equal(calls, 2);
});
