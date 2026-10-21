import {
  appCommandType,
  validateCommand,
  MAX_COMMAND_BYTES,
  SYNC_PUBLIC_ROUTE,
  validSyncRequest,
  MAX_SYNC_FILE_BYTES,
} from '@cantelop/sdk/protocol';
import type { Pool } from 'pg';
import type { Accounts, Account, Installation } from './accounts.js';
import { authenticate, deviceActive, type Identity } from './auth.js';
import { ServiceError, type Config } from './config.js';
import { runtimeJSON } from './terminals.js';
import type { ProtocolEnvelope } from '@cantelop/sdk/protocol';
import type { Platform } from './platform.js';

export async function relay(
  request: Request,
  path: string,
  ctx: {
    pool: Pool;
    cfg: Config;
    accounts: Accounts;
    platform: Platform;
    identity: Identity;
    account: Account;
    installation: Installation;
  },
) {
  const { installation: i } = ctx;
  if (ctx.account.status !== 'active') throw new ServiceError('account_suspended', 403);
  if (request.headers.get('x-juiced-installation') !== i.id)
    throw new ServiceError('installation_changed', 409);
  if (i.status !== 'ready' || !i.platform_id) throw new ServiceError('installation_pending', 409);
  const url = new URL(path, 'https://edge.cantelop.internal'),
    type = appCommandType(url.pathname);
  const contentType = request.headers.get('content-type')?.split(';')[0];
  const max = type ? MAX_COMMAND_BYTES : MAX_SYNC_FILE_BYTES;
  if (Number(request.headers.get('content-length') ?? '0') > max)
    throw new ServiceError('request_too_large', 413);
  const limited = boundedBody(request.body, max);
  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  let body: BodyInit | undefined,
    passive = false,
    envelope: ProtocolEnvelope | undefined;
  if (type) {
    if (request.method !== 'POST' || url.search || contentType !== 'application/json')
      throw new ServiceError('invalid_runtime_request');
    if (type === 'workspace.database')
      throw new ServiceError('database_credentials_unavailable', 403);
    try {
      envelope = validateCommand(await new Response(limited).json());
    } catch {
      throw new ServiceError('invalid_runtime_request');
    }
    if (envelope.command.type !== type) throw new ServiceError('invalid_runtime_request');
    if (type.startsWith('app.environment.') && type !== 'app.environment.status')
      await ctx.accounts.authorize(ctx.identity, ctx.account.id, true);
    if (
      type === 'auth' &&
      envelope.command.type === 'auth' &&
      ['logout', 'terminal', 'login', 'code', 'close', 'cancel'].includes(
        envelope.command.auth.type,
      )
    )
      await ctx.accounts.authorize(ctx.identity, ctx.account.id, true);
    passive = [
      'view',
      'stream',
      'status',
      'stop',
      'cancel',
      'workspace.inspect',
      'workspace.delete',
      'app.environment.unset',
      'app.environment.status',
    ].includes(type);
    // Session IDs/Workspace IDs are checked again by the target App's Edge.
    body = JSON.stringify(envelope);
  } else if (
    SYNC_PUBLIC_ROUTE.test(url.pathname) &&
    validSyncRequest(request.method, url.searchParams)
  ) {
    passive = request.method === 'GET' || request.method === 'DELETE';
    body = limited ?? undefined;
  } else throw new ServiceError('not_found', 404);
  if (!passive && i.desired_package_id) throw new ServiceError('installation_upgrading', 409);
  if (!passive && !ctx.accounts.entitled(ctx.account))
    throw new ServiceError('usage_limit_reached', 403);
  if (
    !['workspace.delete', 'app.environment.unset'].includes(type ?? '') &&
    request.headers.get('x-cantelop-session-runtime') !== null &&
    request.headers.get('x-cantelop-session-runtime') !== i.runtime_id
  )
    throw new ServiceError('cli_upgrade_required', 409);
  const credential = await ctx.platform.credentials(i.platform_id);
  if (credential.appId !== i.app_id || credential.runtimeId !== i.runtime_id)
    throw new ServiceError('installation_changed', 409);
  const headers = new Headers();
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('X-Cantelop-Session-Runtime', i.runtime_id);
  if (type === 'stream') headers.set('Accept', 'text/event-stream');
  const upstream = await ctx.platform.connection(credential).fetch(
    new Request(url, {
      method: request.method,
      headers,
      signal,
      ...(body === undefined ? {} : ({ body, duplex: 'half' } as RequestInit)),
    }),
  );
  if (
    type === 'auth' &&
    envelope?.command.type === 'auth' &&
    envelope.command.auth.type === 'terminal' &&
    upstream.ok
  ) {
    const text = await upstream.text();
    if (Buffer.byteLength(text) > MAX_COMMAND_BYTES)
      throw new ServiceError('invalid_runtime_response', 502);
    const value = JSON.parse(text) as { reply?: { terminalId?: string; type?: string } };
    if (value.reply?.type === 'terminal') {
      const terminal = value.reply.terminalId;
      if (!terminal || !/^trm_[a-f0-9]{32}$/.test(terminal) || !envelope.workspace)
        throw new ServiceError('invalid_runtime_response', 502);
      const inspected = await runtimeJSON(
        ctx.platform,
        i.platform_id,
        i.app_id,
        i.runtime_id,
        {
          protocolVersion: 2,
          id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
          workspace: envelope.workspace,
          session: null,
          command: { type: 'workspace.inspect' },
        },
        'workspace.inspect',
      );
      const workspace = (inspected as { workspace?: { id?: string } }).workspace;
      if (!workspace?.id || !/^wsp_[a-f0-9]{32}$/.test(workspace.id))
        throw new ServiceError('invalid_runtime_response', 502);
      await ctx.pool.query(
        `INSERT INTO terminal_leases(id,account_id,device_id,installation_id,workspace_id,session_id,expires_at) VALUES($1,$2,$3,$4,$5,'cantelop-native-auth',now()+interval '10 minutes') ON CONFLICT DO NOTHING`,
        [terminal, ctx.account.id, ctx.identity.deviceId, i.id, workspace.id],
      );
      // Recheck revocation after persisting before exposing the single-use ticket.
      await authenticate(ctx.pool, ctx.cfg, request);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const outHeaders = new Headers();
  for (const name of ['content-type', 'retry-after', 'x-request-id']) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  outHeaders.set('Cache-Control', 'no-store');
  outHeaders.set('X-Accel-Buffering', 'no');
  if (!upstream.body) return new Response(null, { status: upstream.status, headers: outHeaders });
  const reader = upstream.body.getReader();
  const recheck = setInterval(
    () =>
      void (async () => {
        if (!(await deviceActive(ctx.pool, ctx.identity))) throw new Error('revoked');
        const a = await ctx.accounts.authorize(ctx.identity, ctx.account.id),
          live = await ctx.accounts.installation(a.id);
        if (
          a.status !== 'active' ||
          !live ||
          live.id !== i.id ||
          live.status !== 'ready'
        )
          throw new Error('revoked');
      })().catch(() => {
        cancel.abort();
        void reader.cancel().catch(() => {});
      }),
    5000,
  );
  recheck.unref();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const close = () => {
    clearInterval(recheck);
    signal.removeEventListener('abort', abort);
    cancel.abort();
    void reader.cancel().catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          close();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel: close,
  });
  return new Response(stream, { status: upstream.status, headers: outHeaders });
}
export function boundedBody(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) return null;
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > max) throw new ServiceError('request_too_large', 413);
        controller.enqueue(chunk);
      },
    }),
  );
}
