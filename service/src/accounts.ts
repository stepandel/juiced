import { readInstallation } from '../../contracts/account.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ServiceError } from './config.js';
import { transaction } from './db.js';
import type { Identity } from './auth.js';

export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export interface Account {
  id: string;
  owner_user_id: string;
  status: string;
  entitlement: string;
  period_start?: Date | null;
  period_id: string | null;
  period_end: Date | null;
  included_credits: string;
}
export interface Installation {
  id: string;
  account_id: string;
  external_key: string;
  platform_id: string | null;
  app_id: string | null;
  package_id: string;
  runtime_id: string;
  status: string;
  entitlement_epoch: string | null;
  operation_id?: string | null;
  desired_package_id: string | null;
  desired_runtime_id: string | null;
  policy_revision: number;
  error_code: string | null;
}
export class Accounts {
  constructor(
    readonly pool: Pool,
    readonly release: { packageId: string; runtimeId: string; minimumCli: string },
  ) {}
  async ensure(user: string) {
    return transaction(this.pool, async (tx) => {
      const verified = (
        await tx.query('SELECT 1 FROM "user" WHERE id=$1 AND "emailVerified"=true', [user])
      ).rowCount;
      if (!verified) throw new ServiceError('verified_email_required', 403);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`user:${user}`]);
      let account = (
        await tx.query<Account>('SELECT * FROM accounts WHERE owner_user_id=$1', [user])
      ).rows[0];
      if (!account) {
        account = (
          await tx.query<Account>(
            'INSERT INTO accounts(id,owner_user_id) VALUES($1,$2) RETURNING *',
            [id('acc'), user],
          )
        ).rows[0]!;
        await tx.query("INSERT INTO memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [
          account.id,
          user,
        ]);
      }
      return account;
    });
  }
  async authorize(identity: Identity, account: string, owner = false) {
    const row = (
      await this.pool.query<Account>(
        `SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id
      WHERE a.id=$1 AND m.user_id=$2 AND ($3::boolean=false OR m.role='owner') AND a.status<>'deleted'`,
        [account, identity.userId, owner],
      )
    ).rows[0];
    if (!row) throw new ServiceError('not_found', 404);
    return row;
  }
  async installation(account: string) {
    return (
      await this.pool.query<Installation>('SELECT * FROM installations WHERE account_id=$1', [
        account,
      ])
    ).rows[0];
  }
  entitled(a: Account) {
    return (
      a.status === 'active' &&
      a.entitlement === 'active' &&
      (!a.period_start || a.period_start.getTime() <= Date.now()) &&
      a.period_end !== null &&
      a.period_end.getTime() > Date.now()
    );
  }
  async bootstrap(a: Account, input: { version?: unknown; runtimeId?: unknown }) {
    if (!this.entitled(a))
      throw new ServiceError(
        a.status === 'active' ? 'subscription_required' : 'account_suspended',
        403,
      );
    if (
      typeof input.version !== 'string' ||
      compareVersion(input.version, this.release.minimumCli) < 0 ||
      input.runtimeId !== this.release.runtimeId
    )
      throw new ServiceError('cli_upgrade_required', 409);
    return transaction(this.pool, async (tx) => {
      const current = (
        await tx.query<Account>('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [a.id])
      ).rows[0];
      if (!current || !this.entitled(current)) throw new ServiceError('subscription_required', 403);
      let i = (
        await tx.query<Installation>('SELECT * FROM installations WHERE account_id=$1', [a.id])
      ).rows[0];
      if (!i) {
        i = (
          await tx.query<Installation>(
            `INSERT INTO installations(id,account_id,external_key,package_id,runtime_id,status)
          VALUES($1,$2,$3,$4,$5,'pending') RETURNING *`,
            [id('jin'), a.id, id('installation'), this.release.packageId, this.release.runtimeId],
          )
        ).rows[0]!;
        await enqueue(tx, a.id, 'provision', { installationId: i.id }, `provision:${i.id}`);
      }
      if (
        i.package_id !== this.release.packageId &&
        i.desired_package_id !== this.release.packageId
      ) {
        const intent = (
          await tx.query(
            'UPDATE installations SET desired_package_id=$2,desired_runtime_id=$3,upgrade_generation=upgrade_generation+1 WHERE id=$1 RETURNING upgrade_generation',
            [i.id, this.release.packageId, this.release.runtimeId],
          )
        ).rows[0]!;
        i.operation_id = `upgrade:${i.id}:${intent.upgrade_generation}`;
        await tx.query('UPDATE installations SET operation_id=$2 WHERE id=$1', [
          i.id,
          i.operation_id,
        ]);
        await enqueue(tx, a.id, 'upgrade', {}, i.operation_id);
        i.desired_package_id = this.release.packageId;
        i.desired_runtime_id = this.release.runtimeId;
      }
      if (i.status !== 'ready')
        await enqueue(
          tx,
          a.id,
          'provision',
          {},
          `bootstrap:${i.id}:${i.policy_revision}:${current.period_id}`,
        );
      return publicInstallation(i, this.release.minimumCli);
    });
  }
}
export function publicInstallation(i: Installation, minimumCli: string) {
  return readInstallation({
    id: i.id,
    status: i.desired_package_id ? 'upgrading' : i.status,
    runtimeId: i.runtime_id,
    minimumCli,
    error: i.error_code,
    operationId: i.operation_id ?? `provision:${i.id}`,
  });
}
export async function enqueue(
  tx: Pick<PoolClient, 'query'>,
  account: string,
  kind: string,
  payload: unknown,
  key: string,
) {
  await tx.query(
    'INSERT INTO jobs(id,account_id,kind,payload,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING',
    [id('job'), account, kind, JSON.stringify(payload), key],
  );
}
function compareVersion(a: string, b: string) {
  if (!/^\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+$/.test(b)) return -1;
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let n = 0; n < 3; n++) if (x[n] !== y[n]) return x[n]! > y[n]! ? 1 : -1;
  return 0;
}
