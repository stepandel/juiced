import {
  FleetError,
  FleetConfigurationError,
  type FleetInstanceStatus,
  type FleetPolicyUpdate,
  type AppConnection,
} from '@cantelop/sdk';
import type { fleet } from '../.cantelop/client/client.mjs';
import { ServiceError } from './config';

export type JuicedFleet = typeof fleet;
export interface PlatformInstallation {
  id: string;
  app_id: string;
  package_id: string;
  runtime_id: string;
  status: string;
  policy_revision: number;
  enforced_revision: number;
}
const installation = (value: FleetInstanceStatus): PlatformInstallation => ({
  id: value.id,
  app_id: value.appId,
  package_id: value.packageId,
  runtime_id: value.runtimeId,
  status: value.state,
  policy_revision: value.policyRevision,
  enforced_revision: value.enforcedRevision,
});
export interface InstancePin { appId: string | null; runtimeId: string }
const CONNECTION_TTL_MS = 30_000;
const MAX_CONNECTIONS = 256;
interface CachedConnection {
  expiresAt: number;
  pending: Promise<AppConnection>;
}

/** Translate SDK failures into Juiced's public errors; transport and credentials stay in the SDK. */
export class Platform {
  // Reuse SDK transports, never authorization decisions or Workspace results.
  // Each request still passes Juiced auth and the platform's current Edge gates.
  private readonly connections = new Map<string, CachedConnection>();
  constructor(readonly fleet: JuicedFleet, private readonly now = () => performance.now()) {}

  private async operation<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof FleetError) {
        if (error.code === 'not_found' && error.status === 404)
          throw new ServiceError('platform_not_found', 404);
        if (error.code === 'session_runtime_mismatch')
          throw new ServiceError('installation_changed', 409);
        if (error.code === 'invalid_fleet_response')
          throw new ServiceError('platform_response_invalid', 502);
        throw new ServiceError('platform_unavailable', 503);
      }
      if (error instanceof FleetConfigurationError)
        throw new ServiceError('platform_unavailable', 503);
      throw error;
    }
  }

  install(key: string) {
    return this.operation(async () => installation(await this.fleet.instance({ externalKey: key }).create()));
  }
  remove(key: string) {
    return this.operation(() => this.fleet.instance({ externalKey: key }).delete());
  }
  removeById(id: string) {
    return this.operation(() => this.fleet.instance({ id }).delete());
  }
  find(key: string) {
    return this.operation(async () => {
      const result = await this.fleet.instance({ externalKey: key }).status();
      return result && installation(result);
    });
  }
  installation(id: string) {
    return this.operation(async () => {
      const result = await this.fleet.instance({ id }).status();
      if (!result) throw new ServiceError('platform_not_found', 404);
      return installation(result);
    });
  }
  setPolicy(id: string, update: FleetPolicyUpdate) {
    return this.operation(() => this.fleet.instance({ id }).setPolicy(update));
  }

  /**
   * The SDK reads the instance's status once, requires the compiled runtime, and rejects
   * credentials whose App or runtime differ from that status. Pinning the installation to
   * the compiled runtime here therefore checks the credential actually used, in one
   * status read; the instance id already fixes its App.
   */
  private pinned(id: string, expected: InstancePin) {
    if (!expected.appId || expected.runtimeId !== this.fleet.runtimeId)
      throw new ServiceError('installation_changed', 409);
    return this.fleet.instance({ id });
  }
  connection(id: string, expected: InstancePin): Promise<AppConnection> {
    return this.operation(async () => {
      const instance = this.pinned(id, expected);
      const key = JSON.stringify([id, expected.appId, expected.runtimeId]);
      const cached = this.connections.get(key);
      if (cached && cached.expiresAt > this.now()) {
        this.connections.delete(key);
        this.connections.set(key, cached);
        return cached.pending;
      }
      this.connections.delete(key);
      const entry: CachedConnection = { expiresAt: Infinity, pending: Promise.resolve().then(async () => {
        const connection = await instance.connection();
        entry.expiresAt = this.now() + CONNECTION_TTL_MS;
        return Object.freeze({ ...connection, fetch: async (request: Request) => {
          const response = await connection.fetch(request);
          // Drop rotated credentials and stale runtime bindings. Never replay a
          // command or streaming upload after its body has reached the platform.
          if ([401, 403, 409].includes(response.status) && this.connections.get(key) === entry)
            this.connections.delete(key);
          return response;
        } });
      }).catch(error => {
        if (this.connections.get(key) === entry) this.connections.delete(key);
        throw error;
      }) };
      this.connections.set(key, entry);
      if (this.connections.size > MAX_CONNECTIONS)
        this.connections.delete(this.connections.keys().next().value!);
      return entry.pending;
    });
  }
  app(id: string, expected: InstancePin) {
    return this.operation(async () => (await this.pinned(id, expected)).app());
  }
}
