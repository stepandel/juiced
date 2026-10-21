import type { Pool } from 'pg';
import type { Platform } from './platform.js';
import { ServiceError } from './config.js';

export async function runtimeJSON(
  platform: Platform,
  installation: string,
  app: string | null,
  runtime: string,
  command: unknown,
  type: string,
) {
  const credential = await platform.credentials(installation);
  if (credential.appId !== app || credential.runtimeId !== runtime)
    throw new ServiceError('installation_changed', 409);
  const r = await platform.connection(credential).fetch(
    new Request(`https://runtime.internal/commands/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify(command),
    }),
  );
  if (!r.ok) throw new ServiceError('runtime_unavailable', 503);
  const text = await r.text();
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new ServiceError('invalid_runtime_response', 502);
  return JSON.parse(text) as Record<string, unknown>;
}
export class TerminalCloser {
  constructor(
    private pool: Pool,
    private platform: Platform,
  ) {}
  async runOnce() {
    const rows = await this.pool
      .query(`SELECT t.*,i.platform_id,i.app_id,i.runtime_id FROM terminal_leases t JOIN devices d ON d.id=t.device_id JOIN accounts a ON a.id=t.account_id
      JOIN installations i ON i.id=t.installation_id AND i.account_id=t.account_id
      WHERE t.revoked_at IS NULL AND t.close_after<=now() AND (d.revoked_at IS NOT NULL OR d.expires_at<=now() OR t.expires_at<=now() OR a.status<>'active' OR a.entitlement<>'active') ORDER BY t.close_after LIMIT 20`);
    await Promise.all(
      rows.rows.map(async (t) => {
        try {
          if (!t.platform_id) throw new ServiceError('terminal_close_pending', 503);
          const closed = await runtimeJSON(
            this.platform,
            t.platform_id,
            t.app_id,
            t.runtime_id,
            {
              protocolVersion: 2,
              id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
              workspace: { id: t.workspace_id },
              session: { id: 'cantelop-native-auth' },
              command: {
                type: 'auth',
                auth: { type: 'close', terminalId: t.id },
                timeoutMs: 10000,
                keepAliveSeconds: 0,
              },
            },
            'auth',
          );
          const reply = closed.reply as { type?: string; terminalId?: string } | undefined;
          if (reply?.type !== 'closed' || reply.terminalId !== t.id)
            throw new ServiceError('terminal_close_pending', 503);
          await this.pool.query('UPDATE terminal_leases SET revoked_at=now() WHERE id=$1', [t.id]);
        } catch {
          await this.pool.query(
            "UPDATE terminal_leases SET close_after=now()+interval '5 seconds' WHERE id=$1",
            [t.id],
          );
        }
      }),
    );
    return rows.rowCount !== 0;
  }
}
