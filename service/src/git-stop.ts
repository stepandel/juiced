import { CantelopClient } from '@cantelop/sdk';
import type { Platform } from './platform';
import type { Installation } from './accounts';
import { ServiceError } from './config';

/** No generic SQL endpoint. Snapshot tokens before stop and retire only that attachment. */
export async function stopGitSession(
  platform: Platform,
  i: Installation,
  session: string,
  input: { workspaceId?: unknown; project?: unknown },
) {
  if (
    !/^ses_[a-f0-9]{32}$/.test(session) ||
    typeof input.workspaceId !== 'string' ||
    !/^wsp_[a-f0-9]{32}$/.test(input.workspaceId) ||
    typeof input.project !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.project) ||
    !i.platform_id
  )
    throw new ServiceError('invalid_git_stop');
  const credential = await platform.credentials(i.platform_id);
  if (credential.appId !== i.app_id) throw new ServiceError('installation_changed', 409);
  const app = new CantelopClient().app({
    name: 'juiced',
    runtime: { receive() {} },
    connection: platform.connection(credential),
  });
  const workspace = app.workspace({ id: input.workspaceId });
  if (!(await workspace.inspect())) throw new ServiceError('not_found', 404);
  const db = await workspace.database();
  try {
    const snapshot = await db
      .execute({
        sql: 'SELECT token FROM juiced_checkout_leases WHERE project = ? AND session = ? AND length(token)<=128 LIMIT 1024',
        args: [input.project, session],
      })
      .finally(() => workspace.session({ id: session }).stop());
    for (const row of snapshot.rows)
      await db.execute({
        sql: 'DELETE FROM juiced_checkout_leases WHERE project = ? AND session = ? AND token = ?',
        args: [input.project, session, String(row.token)],
      });
  } finally {
    db.close();
  }
}
