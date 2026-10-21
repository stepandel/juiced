import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, user } from './database';
import { Accounts } from '../src/accounts';
import { TerminalCloser } from '../src/terminals';
import type { Platform } from '../src/platform';

test(
  'terminal revocation retries an unavailable installation without starving other devices',
  { skip: !process.env.JUICED_TEST_DATABASE_URL },
  async () => {
    const f = await testDatabase(),
      { pool } = f;
    try {
      const accounts = new Accounts(pool, {
        packageId: 'pkg_fixture',
        runtimeId: 'runtime-fixture',
        minimumCli: '0.2.0',
      });
      for (const suffix of ['first', 'second']) {
        const owner = await user(pool),
          account = await accounts.ensure(owner);
        await pool.query(
          "INSERT INTO devices(id,user_id,label,expires_at,revoked_at) VALUES($1,$2,'test',now()+interval '1 day',now())",
          [suffix, owner],
        );
        await pool.query(
          "INSERT INTO installations(id,account_id,external_key,platform_id,app_id,package_id,runtime_id,status) VALUES($1,$2,$1,$1,$1,'pkg_fixture','runtime-fixture','ready')",
          [suffix, account.id],
        );
        await pool.query(
          "INSERT INTO terminal_leases(id,account_id,device_id,installation_id,workspace_id,session_id,expires_at) VALUES($1,$2,$1,$1,'wsp_fixture','cantelop-native-auth',now()+interval '1 day')",
          [suffix, account.id],
        );
      }
      let available = false;
      const calls: string[] = [];
      const platform = {
        async credentials(installation: string) {
          return { appId: installation, runtimeId: 'runtime-fixture', installation };
        },
        connection(credential: { installation: string }) {
          return {
            async fetch(request: Request) {
              calls.push(credential.installation);
              if (credential.installation === 'first' && !available)
                throw new Error('host unavailable');
              const body = (await request.json()) as { command: { auth: { terminalId: string } } };
              return Response.json({
                reply: { type: 'closed', terminalId: body.command.auth.terminalId },
              });
            },
          };
        },
      } as unknown as Platform;
      const closer = new TerminalCloser(pool, platform);
      assert.equal(await closer.runOnce(), true);
      const rows = (
        await pool.query(
          'SELECT id,revoked_at,close_after>now() AS retry FROM terminal_leases ORDER BY id',
        )
      ).rows;
      assert.equal(rows[0]!.revoked_at, null);
      assert.equal(rows[0]!.retry, true);
      assert.ok(rows[1]!.revoked_at);
      assert.deepEqual(calls.sort(), ['first', 'second']);
      available = true;
      await pool.query('UPDATE terminal_leases SET close_after=now()');
      assert.equal(await closer.runOnce(), true);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM terminal_leases WHERE revoked_at IS NULL',
          )
        ).rows[0]!.n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
