import type { Pool } from 'pg';
import type { Platform } from './platform';
import { Accounts, type Account } from './accounts';
import type { Billing } from './billing';
import { transaction } from './db';
import { ServiceError } from './config';
import { logError } from './log';
import { currentRelease } from './release';
import { ACCOUNT_LIMITS, policyEpoch } from './resource-policy';

/** Deletion retries must converge once the platform no longer has the installation. */
async function unlessMissing<T>(work: Promise<T>) {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'platform_not_found') return;
    throw error;
  }
}

export class Provisioner {
  constructor(
    private pool: Pool,
    private accounts: Accounts,
    private platform: Platform,
    private billing?: Pick<Billing, 'cancel'>,
  ) {}
  async runOnce(): Promise<boolean> {
    if (!await currentRelease(this.pool, this.accounts.release)) return false;
    const row = (
      await this.pool
        .query(`UPDATE jobs SET status='running',lease_until=now()+interval '60 seconds',fence=fence+1,projection_fence=nextval('projection_fence'),attempts=attempts+1
      WHERE id=(SELECT id FROM jobs WHERE kind IN ('provision','suspend','delete','upgrade') AND (status='pending' AND available_at<=now() OR status='running' AND lease_until<now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)
    ).rows[0];
    if (!row) return false;
    try {
      // Hold the claimed row and account lock across projection. A replacement
      // worker cannot claim this job or race a billing/suspension transition.
      await transaction(this.pool, async (tx) => {
        // Promotion already released this claim; a stale role cannot update it anyway.
        if (!await currentRelease(tx, this.accounts.release, true)) return;
        if (
          !(
            await tx.query(
              "SELECT id FROM jobs WHERE id=$1 AND fence=$2 AND status='running' FOR UPDATE",
              [row.id, row.fence],
            )
          ).rowCount
        )
          return;
        const a = (
          await tx.query<Account>('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [row.account_id])
        ).rows[0]!;
        const i = await this.accounts.installation(a.id, tx);
        if (i && (row.kind === 'delete' || a.status === 'deleting'))
          await unlessMissing(this.platform.remove(i.external_key));
        if (
          i &&
          !i.platform_id &&
          (row.kind === 'delete' || a.status === 'deleting' || !this.accounts.entitled(a))
        ) {
          const recovered = await this.platform.find(i.external_key);
          if (recovered) {
            i.platform_id = recovered.id;
            i.app_id = recovered.app_id;
            await tx.query('UPDATE installations SET platform_id=$2,app_id=$3 WHERE id=$1', [
              i.id,
              recovered.id,
              recovered.app_id,
            ]);
          }
        }
        let done = false;
        if (a.status === 'deleted') done = true;
        else if (row.kind === 'delete' || a.status === 'deleting') {
          await this.billing?.cancel(a, tx);
          if (i?.platform_id) {
            await unlessMissing(this.platform.removeById(i.platform_id));
            const remote = await unlessMissing(this.platform.installation(i.platform_id));
            done = !remote || remote.status === 'deleted';
          } else done = true;
          if (i)
            await tx.query('UPDATE installations SET status=$2 WHERE id=$1', [
              i.id,
              done ? 'deleted' : 'deleting',
            ]);
          if (done) {
            await tx.query(
              "UPDATE accounts SET status='deleted',entitlement='inactive' WHERE id=$1",
              [a.id],
            );
            await tx.query('DELETE FROM memberships WHERE account_id=$1', [a.id]);
            if (
              !(await tx.query('SELECT 1 FROM memberships WHERE user_id=$1', [a.owner_user_id]))
                .rowCount
            ) {
              await tx.query(
                'DELETE FROM terminal_leases WHERE device_id IN (SELECT id FROM devices WHERE user_id=$1)',
                [a.owner_user_id],
              );
              await tx.query(
                'DELETE FROM device_refresh_tokens WHERE device_id IN (SELECT id FROM devices WHERE user_id=$1)',
                [a.owner_user_id],
              );
              await tx.query('DELETE FROM devices WHERE user_id=$1', [a.owner_user_id]);
              await tx.query('DELETE FROM "user" WHERE id=$1', [a.owner_user_id]);
            }
          }
        } else if (
          a.period_start &&
          a.period_start.getTime() > Date.now() &&
          a.status === 'active' &&
          a.entitlement === 'active'
        ) {
          await tx.query(
            `UPDATE jobs SET status='pending',lease_until=NULL,available_at=$3 WHERE id=$1 AND fence=$2`,
            [row.id, row.fence, a.period_start],
          );
          return;
        } else if (!i) done = true;
        else if (!this.accounts.entitled(a) || row.kind === 'suspend') {
          // Re-evaluate current entitlement: an old suspension job cannot undo
          // a renewal that was committed after the job was queued.
          if (this.accounts.entitled(a)) done = true;
          else if (!i.platform_id) done = true;
          else {
            const remote = await this.platform.installation(i.platform_id);
            const result = await this.platform.setPolicy(i.platform_id, {
              expectedRevision: remote.policy_revision,
              sourceFence: String(row.projection_fence),
              policy: {
                active: false,
                expiresAt: new Date().toISOString(),
                maxSandboxes: 0,
                maxVcpus: 0,
                maxMemoryMib: 0,
                maxWorkspaces: 0,
                maxStorageBytes: 0,
              },
            });
            await tx.query(
              'UPDATE installations SET policy_revision=$2,entitlement_epoch=NULL WHERE id=$1',
              [i.id, result.revision],
            );
            done = true;
          }
        } else {
          const remote = i.platform_id
            ? await this.platform.installation(i.platform_id)
            : (await this.platform.find(i.external_key)) ?? await this.platform.install(i.external_key);
          // CLI rollout owns package changes. Wait for its selected package, then adopt its verified identity.
          const failed = remote.status === 'failed';
          if (failed || remote.package_id !== this.accounts.release.packageId || remote.runtime_id !== this.accounts.release.runtimeId) {
            // Only a new or upgrading installation pauses for the rollout. A ready one whose
            // remote moved means this service's release is stale: keep it usable and report.
            const awaiting = i.status !== 'ready' || i.desired_package_id !== null;
            if (failed) await tx.query("UPDATE installations SET status='failed',error_code='platform_failed' WHERE id=$1", [i.id]);
            else if (awaiting) await tx.query("UPDATE installations SET status='provisioning',error_code='installation_upgrading' WHERE id=$1", [i.id]);
            if (failed || !awaiting || row.attempts > 6)
              logError('provisioning_waiting', new Error(failed ? 'platform_installation_failed' : 'release_mismatch'), {
                job: row.id, account: a.id, package: remote.package_id, runtime: remote.runtime_id,
              });
            // Back off from 5 seconds to 5 minutes so a stalled rollout cannot spin the queue.
            await tx.query(
              "UPDATE jobs SET status='pending',lease_until=NULL,available_at=now()+least(300,5*power(2,least($3,8)-1))*interval '1 second' WHERE id=$1 AND fence=$2",
              [row.id, row.fence, row.attempts],
            );
            return;
          }
          // A ready, entitled installation keeps serving under its previous policy
          // while a policy-only change awaits enforcement.
          const usable = i.status === 'ready' && i.desired_package_id === null && i.entitlement_epoch !== null;
          await tx.query('UPDATE installations SET package_id=$2,runtime_id=$3,desired_package_id=NULL,desired_runtime_id=NULL WHERE id=$1', [i.id, remote.package_id, remote.runtime_id]);
          i.package_id = remote.package_id;
          i.runtime_id = remote.runtime_id;
          i.desired_package_id = null;
          i.desired_runtime_id = null;
          await tx.query(
            `UPDATE installations SET platform_id=$2,app_id=$3,status=$4,error_code=NULL,updated_at=now() WHERE id=$1`,
            [i.id, remote.id, remote.app_id, usable ? 'ready' : 'provisioning'],
          );
          let revision = i.policy_revision;
          if (i.entitlement_epoch !== policyEpoch(a.period_id)) {
            const result = await this.platform.setPolicy(remote.id, {
              expectedRevision: remote.policy_revision,
              sourceFence: String(row.projection_fence),
              policy: {
                active: true,
                expiresAt: a.period_end!.toISOString(),
                ...ACCOUNT_LIMITS,
              },
            });
            revision = result.revision;
            await tx.query(
              'UPDATE installations SET policy_revision=$2,entitlement_epoch=$3 WHERE id=$1',
              [i.id, revision, policyEpoch(a.period_id)],
            );
          }
          done =
            remote.status === 'ready' &&
            remote.enforced_revision >= revision &&
            !i.desired_package_id;
          await tx.query(`UPDATE installations SET status=$2,updated_at=now() WHERE id=$1`, [
            i.id,
            done || usable ? 'ready' : 'provisioning',
          ]);
        }
        await tx.query(
          `UPDATE jobs SET status=$3,lease_until=NULL,error_code=NULL,available_at=now()+interval '3 seconds' WHERE id=$1 AND fence=$2`,
          [row.id, row.fence, done ? 'done' : 'pending'],
        );
      });
    } catch (error) {
      logError('provisioning_failed', error, {
        job: row.id,
        kind: row.kind,
        account: row.account_id,
      });
      await this.pool.query(
        `UPDATE jobs SET status='pending',error_code='provisioning_retry_pending',lease_until=NULL,available_at=now()+interval '10 seconds' WHERE id=$1 AND fence=$2`,
        [row.id, row.fence],
      );
    }
    return true;
  }
}
