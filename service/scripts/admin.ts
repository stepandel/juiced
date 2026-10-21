/** Operator-only utility. Run with the worker DB role; never exposed over HTTP. */
import { database, transaction } from '../src/db';
import { required } from '../src/config';
import { enqueue, id } from '../src/accounts';
const [action, account, amount, until] = process.argv.slice(2),
  pool = database(required(process.env, 'JUICED_WORKER_DATABASE_URL'));
try {
  if (action === 'status') {
    const result =
      await pool.query(`SELECT a.id,a.status,a.entitlement,a.period_end,i.status AS installation_status,i.error_code,
    (SELECT count(*) FROM jobs j WHERE j.account_id=a.id AND j.status<>'done') AS pending_operations FROM accounts a LEFT JOIN installations i ON i.account_id=a.id ORDER BY a.created_at DESC LIMIT 100`);
    process.stdout.write(JSON.stringify(result.rows, null, 2) + '\n');
  } else if (action === 'invalidate-devices') {
    await transaction(pool, async (tx) => {
      await tx.query('UPDATE devices SET revoked_at=now()');
      await tx.query('DELETE FROM "session"');
    });
    process.stdout.write('All CLI devices and browser sessions invalidated.\n');
  } else if (action === 'suspend-all') {
    await transaction(pool, async (tx) => {
      const rows = await tx.query(
        `UPDATE accounts SET status='suspended' WHERE status='active' RETURNING id`,
      );
      for (const a of rows.rows)
        await enqueue(tx, String(a.id), 'suspend', {}, `operator-suspend:${a.id}:${id('change')}`);
    });
    process.stdout.write('All accounts suspended; runtime grants will close.\n');
  } else if (account && /^acc_[a-f0-9]{32}$/.test(account) && action === 'grant-alpha') {
    const credits = Number(amount),
      expires = new Date(until ?? '');
    if (
      !Number.isSafeInteger(credits) ||
      credits < 1 ||
      credits > 1e9 ||
      !Number.isFinite(expires.getTime()) ||
      expires.getTime() <= Date.now() ||
      expires.getTime() > Date.now() + 7 * 86400000
    )
      throw new Error('Alpha grants require 1..1e9 credits and an expiry within seven days');
    await transaction(pool, async (tx) => {
      const epoch = id('alpha');
      const updated = await tx.query(
        `UPDATE accounts SET entitlement='active',period_id=$2,period_start=now(),period_end=$3,included_credits=$4 WHERE id=$1 AND status='active' RETURNING id`,
        [account, epoch, expires, credits],
      );
      if (!updated.rowCount) throw new Error('Active account not found');
      await tx.query(
        'INSERT INTO entitlement_grants(id,account_id,credits,expires_at) VALUES($1,$2,$3,$4)',
        [epoch, account, credits, expires],
      );
      await tx.query(
        `INSERT INTO audit(account_id,actor,action,target) VALUES($1,'operator','entitlement.alpha',$2)`,
        [account, epoch],
      );
      await enqueue(tx, account, 'provision', {}, `alpha:${account}:${epoch}`);
    });
    process.stdout.write('Bounded operator-funded alpha grant recorded.\n');
  } else
    throw new Error(
      'Usage: admin.ts status | invalidate-devices | suspend-all | grant-alpha ACCOUNT CREDITS ISO_EXPIRY',
    );
} finally {
  await pool.end();
}
