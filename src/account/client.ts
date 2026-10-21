import { readIdentity, readInstallation } from '../../contracts/account.js';
import { hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { AppConnection } from '@cantelop/sdk';
import { CredentialStore, savedOrigin, rememberOrigin, type Credentials } from './store.js';

declare const JUICED_DEFAULT_SERVICE_URL: string;
const execute = promisify(execFile);
export class ManagedError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(messages[code] ?? `Juiced service request failed: ${code}`);
  }
}
const messages: Record<string, string> = {
  managed_admission_closed:
    'Your account’s compute capacity or allowance is unavailable. Check usage or wait for running work to finish.',
  installation_upgrading:
    'Your workspace service is upgrading after active work finishes. Retry shortly.',
  not_signed_in: 'Sign in with juiced login.',
  device_revoked: 'This device has been signed out. Run juiced login.',
  subscription_required:
    'An active Juiced subscription is required. Manage your account in the Juiced web app.',
  usage_limit_reached:
    'Your included Juiced usage is exhausted. New work is paused until the allowance renews.',
  cli_upgrade_required:
    'This Juiced version needs an update. Install the latest CLI and reconnect.',
  installation_changed: 'This command’s installation changed. Start a new Juiced command.',
  installation_pending: 'Your workspace service is being provisioned. Retry shortly.',
};
export class AccountClient {
  readonly origin: string;
  readonly store: CredentialStore;
  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    private fetcher: typeof fetch = fetch,
  ) {
    const configured =
      env.JUICED_SERVICE_URL ??
      savedOrigin(env) ??
      (typeof JUICED_DEFAULT_SERVICE_URL === 'undefined' ? '' : JUICED_DEFAULT_SERVICE_URL);
    if (!configured)
      throw new Error(
        'Configure Juiced with juiced --service https://YOUR-SERVICE login, or set JUICED_SERVICE_URL.',
      );
    const url = new URL(configured);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          env.JUICED_ALLOW_LOCAL === '1' &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('JUICED_SERVICE_URL must be an HTTPS origin.');
    this.origin = url.origin;
    this.store = new CredentialStore(this.origin, env);
  }
  async response(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    authenticated = true,
    runtime = false,
  ): Promise<Response> {
    const token = authenticated ? await this.token(signal) : undefined;
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const result = await this.fetcher(new URL(path, this.origin), {
      ...init,
      headers,
      signal,
      redirect: 'error',
    });
    if (result.ok || (runtime && !result.headers.has('x-juiced-error'))) return result;
    const error = (await result.json().catch(() => ({}))) as { error?: string };
    const known = new ManagedError(
      typeof error.error === 'string' ? error.error : 'service_unavailable',
      result.status,
    );
    if (known.code === 'subscription_required') known.message += ` Open ${this.origin}/account.`;
    throw known;
  }
  async json<T>(
    path: string,
    body: unknown,
    signal: AbortSignal,
    method = 'POST',
    authenticated = true,
  ): Promise<T> {
    const response = await this.response(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      signal,
      authenticated,
    );
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new ManagedError('invalid_service_response');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ManagedError('invalid_service_response');
    }
  }
  async token(signal: AbortSignal) {
    return this.store.locked(signal, async () => {
      let saved = await this.store.read();
      if (!saved) throw new ManagedError('not_signed_in');
      if (saved.expiresAt > Date.now() + 30000) return saved.accessToken;
      const r = await this.fetcher(new URL('/api/auth/oauth2/token', this.origin), {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'juiced-cli',
          grant_type: 'refresh_token',
          refresh_token: saved.refreshToken,
        }),
      });
      if (!r.ok) throw new ManagedError('device_revoked', r.status);
      const next = (await r.json().catch(() => {
        throw new ManagedError('invalid_service_response');
      })) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      saved = {
        ...saved,
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
        expiresAt: Date.now() + next.expires_in * 1000,
      };
      await this.store.write(saved);
      return saved.accessToken;
    });
  }
  async login(signal: AbortSignal, noBrowser = false) {
    // Browser approval can take minutes. Serialize logins separately so commands
    // in other terminals can still read and refresh the shared credentials.
    await this.store.locked(signal, async () => {
      if (await this.store.read()) {
        let signedIn = false;
        try {
          await this.me(signal);
          signedIn = true;
        } catch (error) {
          if (!(error instanceof ManagedError && (error.status === 401 || error.code === 'not_signed_in')))
            throw error;
        }
        if (signedIn) {
          await rememberOrigin(this.origin, this.env);
          process.stderr.write(
            'Already signed in to Juiced. All terminal windows share this sign-in.\nTo switch accounts, run juiced logout first.\n',
          );
          return;
        }
      }
      await this.deviceLogin(signal, noBrowser);
    }, 'login');
  }
  private async deviceLogin(signal: AbortSignal, noBrowser: boolean) {
    const started = await this.json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>(
      '/api/auth/device/code',
      {
        client_id: 'juiced-cli',
        scope: 'juiced offline_access',
        resource: this.origin,
      },
      signal,
      'POST',
      false,
    );
    const verification = new URL(started.verification_uri, this.origin);
    if (verification.origin !== this.origin) throw new ManagedError('invalid_service_response');
    verification.searchParams.set('user_code', started.user_code);
    process.stderr.write(`Open ${verification.href}\nConfirm device code ${started.user_code}.\n`);
    if (!noBrowser) {
      const [bin, args] =
        process.platform === 'darwin'
          ? ['open', [verification.href]]
          : process.platform === 'win32'
            ? ['rundll32.exe', ['url.dll,FileProtocolHandler', verification.href]]
            : ['xdg-open', [verification.href]];
      await execute(bin as string, args as string[], { signal, timeout: 5000 }).catch(() => {});
    }
    const until = Date.now() + Math.min(started.expires_in, 600) * 1000;
    let interval = Math.max(started.interval, 5);
    while (Date.now() < until) {
      await delay(interval * 1000, undefined, { signal });
      const r = await this.fetcher(new URL('/api/auth/oauth2/token', this.origin), {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Juiced-Device-Name': (this.env.JUICED_DEVICE_NAME ?? hostname())
            .replace(/[^A-Za-z0-9 ._-]/g, '')
            .slice(0, 64),
        },
        body: new URLSearchParams({
          client_id: 'juiced-cli',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: started.device_code,
        }),
      });
      const value = (await r.json().catch(() => {
        throw new ManagedError('invalid_service_response');
      })) as {
        error?: string;
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      if (r.ok) {
        await this.store.locked(signal, () =>
          this.store.write({
            origin: this.origin,
            accessToken: value.access_token,
            refreshToken: value.refresh_token,
            expiresAt: Date.now() + value.expires_in * 1000,
          }),
        );
        const me = await this.me(signal);
        const account = me.accounts[0]?.id;
        if (account)
          await this.store.locked(signal, async () => {
            const saved = (await this.store.read())!;
            await this.store.write({ ...saved, account });
          });
        await rememberOrigin(this.origin, this.env);
        process.stderr.write(`Signed in to Juiced${account ? ` account ${account}` : ''}.\n`);
        return;
      }
      if (value.error === 'authorization_pending') continue;
      if (value.error === 'slow_down') {
        interval += 5;
        continue;
      }
      throw new ManagedError(value.error ?? 'login_failed', r.status);
    }
    throw new ManagedError('login_expired');
  }
  me(signal: AbortSignal) {
    return this.json<unknown>('/v1/me', undefined, signal, 'GET').then(readIdentity);
  }
  async prepare(
    version: string,
    runtimeId: string | undefined,
    account: string | undefined,
    signal: AbortSignal,
    passive = false,
  ) {
    if (!runtimeId) throw new ManagedError('cli_upgrade_required');
    if (!(await this.store.read()) && process.stdin.isTTY && process.stderr.isTTY)
      await this.login(signal);
    const me = await this.me(signal),
      saved = await this.store.read();
    account ??= saved?.account ?? me.accounts[0]?.id;
    if (!account || !me.accounts.some((a) => a.id === account))
      throw new ManagedError('account_not_available');
    let result = readInstallation(
      passive
        ? await this.json(`/v1/accounts/${account}/installation`, undefined, signal, 'GET')
        : await this.json(`/v1/accounts/${account}/bootstrap`, { version, runtimeId }, signal),
    );
    const until = Date.now() + 300000;
    let progress = false;
    while (
      result.status !== 'ready' &&
      !(passive && result.status === 'upgrading') &&
      Date.now() < until
    ) {
      if (!progress) {
        process.stderr.write('Preparing your isolated Juiced workspace service…\n');
        progress = true;
      }
      await delay(2000, undefined, { signal });
      result = readInstallation(
        await this.json(`/v1/accounts/${account}/installation`, undefined, signal, 'GET'),
      );
      if (result.status === 'failed') throw new ManagedError('installation_failed', 503);
    }
    if (result.status !== 'ready' && !(passive && result.status === 'upgrading'))
      throw new ManagedError('installation_pending', 409);
    if (!passive && result.runtimeId !== runtimeId)
      throw new ManagedError('cli_upgrade_required', 409);
    const selected = account,
      installation = result.id;
    const scope = createHash('sha256')
      .update(JSON.stringify([this.origin, selected, installation]))
      .digest('hex');
    const connection: AppConnection = {
      fetch: async (request) => {
        const url = new URL(request.url),
          headers = new Headers(request.headers);
        headers.set('X-Juiced-Installation', installation);
        if (!headers.has('X-Cantelop-Session-Runtime'))
          headers.set('X-Cantelop-Session-Runtime', runtimeId);
        return this.response(
          `/v1/accounts/${selected}/runtime${url.pathname}${url.search}`,
          {
            method: request.method,
            headers,
            ...(request.body === null
              ? {}
              : ({ body: request.body, duplex: 'half' } as RequestInit)),
          },
          request.signal,
          true,
          true,
        );
      },
    };
    return {
      scope,
      connection,
      stop: async (session: string, workspaceId: string, project: string) => {
        await this.response(
          `/v1/accounts/${selected}/git-sessions/${session}/stop`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Juiced-Installation': installation },
            body: JSON.stringify({ workspaceId, project }),
          },
          signal,
        );
      },
    };
  }
}
