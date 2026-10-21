/** Operator-only utility. Run with the worker DB role; never exposed over HTTP. */
import { database, transaction } from '../src/db';
import { required } from '../src/config';
import { enqueue, id } from '../src/accounts';
const [action] = process.argv.slice(2),
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
  } else
    throw new Error('Usage: admin.ts status | invalidate-devices | suspend-all');
} finally {
  await pool.end();
}
