import Stripe from 'stripe';
import type { Pool, PoolClient } from 'pg';
import { transaction, type Queryable } from './db';
import { id, enqueue, type Account } from './accounts';
import { ServiceError, readText } from './config';

/**
 * Stripe rejects a Checkout expiry under 30 minutes away. An idempotent replay
 * of a request Stripe already executed returns the saved session instead, so
 * this rejection means the stored intent never created a session.
 */
const neverCreated = (error: unknown) =>
  (error as { type?: string }).type === 'StripeInvalidRequestError' &&
  (error as { param?: string }).param === 'expires_at';

export interface BillingConfig {
  price: string;
  credits: number;
  webhookSecret: string;
  origin: string;
  liveMode?: boolean;
  portalConfiguration?: string;
}
export class Billing {
  private checked: Promise<void> | undefined;
  constructor(
    private pool: Pool,
    private stripe: Stripe,
    readonly cfg: BillingConfig,
  ) {
    if (
      !/^price_[A-Za-z0-9]+$/.test(cfg.price) ||
      !Number.isSafeInteger(cfg.credits) ||
      cfg.credits < 1 ||
      cfg.credits > 1e12 ||
      !cfg.webhookSecret.startsWith('whsec_')
    )
      throw new Error('Invalid billing configuration');
  }
  /** Verify the Stripe configuration once; a failure is retried on the next call. */
  ready() {
    return (this.checked ??= this.check().catch((error: unknown) => {
      this.checked = undefined;
      throw error;
    }));
  }
  async check() {
    const price = await this.stripe.prices.retrieve(this.cfg.price);
    if (
      !price.active ||
      price.type !== 'recurring' ||
      price.recurring?.usage_type !== 'licensed' ||
      price.billing_scheme !== 'per_unit' ||
      price.unit_amount === null ||
      price.unit_amount <= 0 ||
      price.livemode !== (this.cfg.liveMode ?? false)
    )
      throw new Error('Juiced requires an active fixed-price licensed subscription');
    if (this.cfg.portalConfiguration) {
      const portal = await this.stripe.billingPortal.configurations.retrieve(
        this.cfg.portalConfiguration,
      );
      if (!portal.active || portal.features.subscription_update.enabled)
        throw new Error('Juiced portal must disable subscription price changes');
    }
  }
  async webhook(request: Request) {
    const body = await readText(request, 1024 * 1024);
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        body,
        request.headers.get('stripe-signature') ?? '',
        this.cfg.webhookSecret,
      );
    } catch {
      throw new ServiceError('invalid_webhook', 400);
    }
    if (event.livemode !== (this.cfg.liveMode ?? false))
      throw new ServiceError('billing_mode_mismatch', 400);
    await this.pool.query(
      'INSERT INTO billing_events(id,type,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [event.id, event.type, JSON.stringify(event)],
    );
    return { received: true };
  }
  async customer(a: Account) {
    return transaction(this.pool, async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [a.id]);
      const old = (
        await tx.query('SELECT customer_id FROM subscriptions WHERE account_id=$1', [a.id])
      ).rows[0];
      if (old) return String(old.customer_id);
      const c = await this.stripe.customers.create(
        { metadata: { juiced_account: a.id } },
        { idempotencyKey: `juiced-customer:${a.id}` },
      );
      await tx.query('INSERT INTO subscriptions(account_id,customer_id) VALUES($1,$2)', [
        a.id,
        c.id,
      ]);
      return c.id;
    });
  }
  async checkout(a: Account) {
    if (a.status !== 'active') throw new ServiceError('account_suspended', 403);
    await this.ready();
    const customer = await this.customer(a);
    // A paid or unfinished subscription is managed through the portal; never
    // create a second subscription for an existing entitlement.
    const existing = (
      await this.pool.query('SELECT subscription_id FROM subscriptions WHERE account_id=$1', [a.id])
    ).rows[0];
    if (existing?.subscription_id) return this.portal(a);
    let intent = await transaction(this.pool, async (tx) => {
      await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [a.id]);
      const old = (
        await tx.query(
          "SELECT * FROM checkout_sessions WHERE account_id=$1 AND expires_at>now()+interval '1 minute'",
          [a.id],
        )
      ).rows[0];
      if (old) return old;
      const expired = (
        await tx.query('SELECT * FROM checkout_sessions WHERE account_id=$1', [a.id])
      ).rows[0];
      if (expired) await this.expireCheckout(a.id, customer, expired);
      return (
        await tx.query(
          `INSERT INTO checkout_sessions(account_id,intent_id,expires_at) VALUES($1,$2,now()+interval '31 minutes')
        ON CONFLICT(account_id) DO UPDATE SET intent_id=excluded.intent_id,url=NULL,stripe_id=NULL,expires_at=excluded.expires_at RETURNING *`,
          [a.id, id('checkout')],
        )
      ).rows[0]!;
    });
    if (intent.url) return { url: String(intent.url) };
    return transaction(this.pool, async (tx) => {
      const live = (await tx.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE', [a.id]))
        .rows[0];
      if (live?.status !== 'active') throw new ServiceError('account_suspended', 403);
      const existing = await this.stripe.subscriptions.list({
        customer,
        status: 'all',
        limit: 100,
      });
      if (existing.has_more) throw new ServiceError('billing_reconciliation_required', 503);
      if (
        existing.data.some(
          (sub) =>
            sub.metadata.juiced_account === a.id &&
            !['canceled', 'incomplete_expired'].includes(sub.status),
        )
      ) {
        const portal = await this.stripe.billingPortal.sessions.create({
          customer,
          return_url: `${this.cfg.origin}/account`,
          ...(this.cfg.portalConfiguration ? { configuration: this.cfg.portalConfiguration } : {}),
        });
        return { url: portal.url };
      }
      let session;
      try {
        session = await this.checkoutSession(a.id, customer, intent);
      } catch (error) {
        if (!neverCreated(error)) throw error;
        intent = (
          await tx.query(
            `UPDATE checkout_sessions SET intent_id=$3,expires_at=now()+interval '31 minutes' WHERE account_id=$1 AND intent_id=$2 RETURNING *`,
            [a.id, intent.intent_id, id('checkout')],
          )
        ).rows[0];
        if (!intent) throw new ServiceError('billing_retry_pending', 409);
        session = await this.checkoutSession(a.id, customer, intent);
      }
      if (!session.url) throw new ServiceError('billing_unavailable', 503);
      await tx.query(
        'UPDATE checkout_sessions SET url=$3,stripe_id=$4 WHERE account_id=$1 AND intent_id=$2',
        [a.id, intent.intent_id, session.url, session.id],
      );
      return { url: session.url };
    });
  }
  private checkoutSession(account: string, customer: string, intent: Record<string, unknown>) {
    return this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer,
        client_reference_id: account,
        line_items: [{ price: this.cfg.price, quantity: 1 }],
        subscription_data: { metadata: { juiced_account: account } },
        metadata: { juiced_account: account },
        success_url: `${this.cfg.origin}/account?checkout=complete`,
        cancel_url: `${this.cfg.origin}/account`,
        expires_at: Math.floor(new Date(String(intent.expires_at)).getTime() / 1000),
      },
      { idempotencyKey: String(intent.intent_id) },
    );
  }

  async portal(a: Account) {
    await this.ready();
    const customer = await this.customer(a),
      session = await this.stripe.billingPortal.sessions.create({
        customer,
        return_url: `${this.cfg.origin}/account`,
        ...(this.cfg.portalConfiguration ? { configuration: this.cfg.portalConfiguration } : {}),
      });
    return { url: session.url };
  }
  private async expireCheckout(account: string, customer: string, intent: Record<string, unknown>) {
    if (new Date(String(intent.expires_at)).getTime() <= Date.now()) return;
    let checkout;
    try {
      checkout = intent.stripe_id
        ? await this.stripe.checkout.sessions.retrieve(String(intent.stripe_id))
        : await this.checkoutSession(account, customer, intent);
    } catch (error) {
      if (!intent.stripe_id && neverCreated(error)) return;
      throw error;
    }
    if (checkout.status === 'open') {
      try {
        await this.stripe.checkout.sessions.expire(checkout.id);
      } catch (error) {
        const current = await this.stripe.checkout.sessions.retrieve(checkout.id);
        if (current.status === 'open') throw error;
      }
    }
  }
  /** Pass the caller's transaction so cancellation does not take a second connection. */
  async cancel(a: Account, db: Queryable = this.pool) {
    const binding = (await db.query('SELECT * FROM subscriptions WHERE account_id=$1', [a.id]))
      .rows[0];
    if (!binding) return;
    const customer = String(binding.customer_id);
    const intent = (await db.query('SELECT * FROM checkout_sessions WHERE account_id=$1', [a.id]))
      .rows[0];
    if (intent) await this.expireCheckout(a.id, customer, intent);
    const list = await this.stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    if (list.has_more) throw new ServiceError('billing_reconciliation_required', 503);
    for (const sub of list.data)
      if (
        sub.metadata.juiced_account === a.id &&
        !['canceled', 'incomplete_expired'].includes(sub.status)
      )
        await this.stripe.subscriptions.cancel(
          sub.id,
          { prorate: false, invoice_now: false },
          { idempotencyKey: `juiced-delete:${a.id}:${sub.id}` },
        );
  }
  async runOnce() {
    let failedEvent: string | undefined, failedAccount: string | undefined;
    try {
      const event = await transaction(this.pool, async (tx) => {
        const e = (
          await tx.query(
            `SELECT * FROM billing_events WHERE processed_at IS NULL AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
          )
        ).rows[0];
        if (!e) return false;
        failedEvent = String(e.id);
        const object = (e.payload as Stripe.Event).data.object as unknown as {
          customer?: string | { id: string };
          id?: string;
          object?: string;
        };
        const customer =
          typeof object.customer === 'string' ? object.customer : object.customer?.id;
        if (customer) {
          const sub = (
            await tx.query('SELECT account_id FROM subscriptions WHERE customer_id=$1', [customer])
          ).rows[0];
          if (sub) await this.reconcile(tx, String(sub.account_id), customer);
        }
        await tx.query('UPDATE billing_events SET processed_at=now(),error_code=NULL WHERE id=$1', [
          e.id,
        ]);
        return true;
      });
      if (event) return true;
      // Webhooks are the prompt path; authoritative polling repairs lost events.
      return await transaction(this.pool, async (tx) => {
        const row = (
          await tx.query(`SELECT s.* FROM subscriptions s JOIN accounts a ON a.id=s.account_id WHERE a.status<>'deleted'
        AND (s.reconciled_at IS NULL OR s.reconciled_at<now()-interval '5 minutes') ORDER BY s.reconciled_at NULLS FIRST FOR UPDATE OF s SKIP LOCKED LIMIT 1`)
        ).rows[0];
        if (!row) return false;
        failedAccount = String(row.account_id);
        await this.reconcile(tx, String(row.account_id), String(row.customer_id));
        return true;
      });
    } catch (error) {
      if (failedEvent)
        await this.pool.query(
          `UPDATE billing_events SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds',error_code='billing_retry_pending' WHERE id=$1`,
          [failedEvent],
        );
      else if (failedAccount)
        await this.pool.query('UPDATE subscriptions SET reconciled_at=now() WHERE account_id=$1', [
          failedAccount,
        ]);
      throw error;
    }
  }
  private async reconcile(tx: PoolClient, account: string, customer: string) {
    await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [account]);
    // Never trust webhook metadata to assign ownership. The customer was bound
    // by our authenticated checkout before Stripe accepted a payment.
    const list = await this.stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    const matches = list.data.filter(
      (s) =>
        s.metadata.juiced_account === account &&
        s.items.data.length === 1 &&
        s.items.data[0]!.price.id === this.cfg.price &&
        s.items.data[0]!.quantity === 1,
    );
    const sub = matches.sort((a, b) => b.created - a.created)[0];
    if (!sub) {
      await tx.query('UPDATE subscriptions SET reconciled_at=now() WHERE account_id=$1', [account]);
      return;
    }
    if (list.has_more) throw new ServiceError('billing_reconciliation_required', 503);
    const a = (await tx.query<Account>('SELECT * FROM accounts WHERE id=$1', [account])).rows[0]!;
    await tx.query(
      'UPDATE subscriptions SET subscription_id=$2,status=$3,reconciled_at=now() WHERE account_id=$1',
      [account, sub.id, sub.status],
    );
    if (a.status === 'deleted' || a.status === 'deleting') return;
    const item = sub.items.data[0]!,
      invoiceId =
        typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
    let grant = false;
    if (sub.status === 'active' && invoiceId) {
      const invoice = await this.stripe.invoices.retrieve(invoiceId);
      const line = invoice.lines.data.find(
        (l) =>
          l.pricing?.price_details?.price === this.cfg.price &&
          l.period.start === item.current_period_start &&
          l.period.end === item.current_period_end,
      );
      if (
        invoice.status === 'paid' &&
        line &&
        invoice.customer === customer &&
        invoice.parent?.subscription_details?.subscription === sub.id &&
        line.period.end > line.period.start &&
        line.period.end - line.period.start <= 366 * 86400
      ) {
        await tx.query(
          'INSERT INTO entitlement_grants(id,account_id,credits,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [invoice.id, account, this.cfg.credits, new Date(line.period.end * 1000)],
        );
        // Current authoritative subscription plus a settled invoice grants one
        // immutable epoch. Replaying an event cannot refill an exhausted epoch.
        // A paid epoch always replaces the free allowance (migration 0011).
        if (
          a.period_id !== invoice.id &&
          (a.period_id === 'free' ||
            !a.period_end ||
            a.period_end.getTime() <= line.period.end * 1000)
        ) {
          await tx.query(
            `UPDATE accounts SET period_id=$2,period_start=$3,period_end=$4,included_credits=$5,entitlement='active' WHERE id=$1 AND status='active'`,
            [
              account,
              invoice.id,
              new Date(line.period.start * 1000),
              new Date(line.period.end * 1000),
              this.cfg.credits,
            ],
          );
          const inst = (
            await tx.query('SELECT id FROM installations WHERE account_id=$1', [account])
          ).rows[0];
          if (inst) await enqueue(tx, account, 'provision', {}, `renew:${inst.id}:${invoice.id}`);
        } else if (a.period_id === invoice.id && a.entitlement === 'inactive') {
          // A transient non-grant (past_due, paused) suspended this epoch; the
          // same settled invoice restores it. Exhaustion is never undone here.
          const restored = await tx.query(
            `UPDATE accounts SET entitlement='active' WHERE id=$1 AND status='active' AND entitlement='inactive' AND period_end>now() RETURNING id`,
            [account],
          );
          const inst = (
            await tx.query('SELECT id FROM installations WHERE account_id=$1', [account])
          ).rows[0];
          if (inst && restored.rowCount)
            await enqueue(
              tx,
              account,
              'provision',
              {},
              `reactivate:${inst.id}:${invoice.id}:${id('transition')}`,
            );
        }
        grant = true;
      }
    }
    if (!grant) {
      const changed = await tx.query(
        `UPDATE accounts SET entitlement='inactive' WHERE id=$1 AND entitlement<>'inactive' RETURNING id`,
        [account],
      );
      if (changed.rowCount)
        await enqueue(tx, account, 'suspend', {}, `suspend:${account}:${id('transition')}`);
    }
  }
}
