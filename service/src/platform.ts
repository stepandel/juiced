import type { AppConnection } from '@cantelop/sdk';
import { ServiceError, origin } from './config';
export interface PlatformInstallation {
  id: string;
  app_id: string;
  package_id: string;
  runtime_id: string;
  status: string;
  policy_revision: number;
  enforced_revision: number;
}
export interface RuntimeCredential {
  appId: string;
  edgeUrl: string;
  accessToken: string;
  runtimeId: string;
}
export class Platform {
  private origin: string;
  constructor(
    url: string,
    private fleet: string,
    private token: string,
    private fetcher: typeof fetch = fetch,
    development = false,
  ) {
    this.origin = origin(url, development);
    if (!/^flt_[a-f0-9]{32}$/.test(fleet) || !/^fsp_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token))
      throw new Error('Invalid Fleet credentials');
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.origin}/v1/fleets/${this.fleet}/${path}`, {
      method,
      redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new ServiceError('platform_response_invalid', 502);
    let value: unknown;
    try {
      value = text === '' && response.ok ? undefined : JSON.parse(text);
    } catch {
      throw new ServiceError('platform_response_invalid', 502);
    }
    if (!response.ok)
      throw new ServiceError(
        response.status === 404 ? 'platform_not_found' : 'platform_unavailable',
        response.status === 404 ? 404 : 503,
      );
    return value as T;
  }
  install(key: string, packageId: string) {
    return this.request<PlatformInstallation>('PUT', `installations/${encodeURIComponent(key)}`, {
      packageId,
    });
  }
  remove(key: string) {
    return this.request('DELETE', `installations?externalKey=${encodeURIComponent(key)}`);
  }
  async find(key: string) {
    try {
      return await this.request<PlatformInstallation>(
        'GET',
        `installations?externalKey=${encodeURIComponent(key)}`,
      );
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'platform_not_found') return;
      throw error;
    }
  }
  installation(id: string) {
    return this.request<PlatformInstallation>('GET', `installations/${encodeURIComponent(id)}`);
  }
  credentials(id: string) {
    return this.request<RuntimeCredential>(
      'GET',
      `installations/${encodeURIComponent(id)}/credentials`,
    );
  }
  connection(credential: RuntimeCredential): AppConnection {
    const edge = origin(credential.edgeUrl, this.origin.startsWith('http:'));
    return {
      fetch: async (request: Request) => {
        const source = new URL(request.url),
          headers = new Headers();
        for (const key of ['content-type', 'accept', 'x-cantelop-session-runtime']) {
          const value = request.headers.get(key);
          if (value !== null) headers.set(key, value);
        }
        headers.set('Authorization', `Bearer ${credential.accessToken}`);
        headers.set('X-Cantelop-Session-Runtime', credential.runtimeId);
        return this.fetcher(
          new Request(new URL(source.pathname + source.search, edge), {
            method: request.method,
            headers,
            redirect: 'manual',
            signal: request.signal,
            ...(request.body === null
              ? {}
              : ({ body: request.body, duplex: 'half' } as RequestInit)),
          }),
        );
      },
    };
  }
}
