import type { Pool } from 'pg';
import type { Platform } from './platform';
import { transaction } from './db';
import { enqueue } from './accounts';

export class UsageIngestor {
  constructor(
    private pool: Pool,
    private platform: Platform,
  ) {}
  async runOnce() {
    return transaction(this.pool, async (tx) => {
      await tx.query(
        "INSERT INTO settings(key,value) VALUES('usage_cursor','0') ON CONFLICT DO NOTHING",
      );
      const cursor = String(
        (await tx.query("SELECT value FROM settings WHERE key='usage_cursor' FOR UPDATE")).rows[0]!
          .value,
      );
      const data = await this.platform.request<{
        items: { id: string; sequence: string; app_id: string; credits: string; epoch: string }[];
        after: string;
      }>('GET', `usage?after=${cursor}`);
      if (!Array.isArray(data.items) || data.items.length > 500)
        throw new Error('invalid_usage_page');
      let next = BigInt(cursor);
      const touched = new Map<string, { account: string; epoch: string }>();
      for (const event of data.items) {
        if (
          !/^\d+$/.test(event.sequence) ||
          BigInt(event.sequence) <= next ||
          !/^\d+$/.test(event.credits) ||
          BigInt(event.credits) > BigInt(Number.MAX_SAFE_INTEGER) ||
          typeof event.epoch !== 'string'
        )
          throw new Error('invalid_usage_event');
        next = BigInt(event.sequence);
        const account = (
          await tx.query(
            `SELECT a.id FROM accounts a JOIN installations i ON i.account_id=a.id WHERE i.app_id=$1 FOR UPDATE OF a`,
            [event.app_id],
          )
        ).rows[0];
        // Unknown App evidence must be investigated, never skipped by advancing
        // a cursor that could silently lose a customer's usage.
        if (!account) throw new Error('usage_app_unmapped');
        await tx.query(
          'INSERT INTO usage_events(id,account_id,sequence,credits,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
          [event.id, account.id, event.sequence, event.credits, JSON.stringify(event)],
        );
        touched.set(`${account.id}\0${event.epoch}`, {
          account: String(account.id),
          epoch: event.epoch,
        });
      }
      // Check each epoch once per page rather than re-summing per event.
      for (const { account, epoch } of touched.values()) {
        const exhausted = await tx.query(
          `UPDATE accounts SET entitlement='exhausted' WHERE id=$1 AND period_id=$2 AND entitlement='active'
          AND included_credits<=(SELECT coalesce(sum(credits),0) FROM usage_events WHERE account_id=$1 AND payload->>'epoch'=$2) RETURNING id`,
          [account, epoch],
        );
        if (exhausted.rowCount)
          await enqueue(tx, account, 'suspend', {}, `exhausted:${account}:${epoch}`);
      }
      if (String(next) !== data.after) throw new Error('invalid_usage_cursor');
      await tx.query("UPDATE settings SET value=$1 WHERE key='usage_cursor'", [String(next)]);
      return data.items.length > 0;
    });
  }
}
