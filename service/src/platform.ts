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

/** Translate SDK failures into Juiced's public errors; transport and credentials stay in the SDK. */
export class Platform {
  constructor(readonly fleet: JuicedFleet) {}

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
    return this.operation(async () => (await this.pinned(id, expected)).connection());
  }
  app(id: string, expected: InstancePin) {
    return this.operation(async () => (await this.pinned(id, expected)).app());
  }
}
