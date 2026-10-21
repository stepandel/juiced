import { isCliVersion } from './cli-version.ts';

/** Wire contract shared by the packaged CLI and the managed service. */
export interface InstallationMetadata {
  id: string;
  status: string;
  runtimeId: string;
  minimumCli: string;
  error: string | null;
  operationId: string;
}
export interface AccountIdentity {
  userId: string;
  deviceId: string;
  accounts: { id: string; status: string; entitlement: string }[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export function readInstallation(v: unknown): InstallationMetadata {
  if (
    !object(v) ||
    typeof v.id !== 'string' ||
    !/^jin_[a-f0-9]{32}$/.test(v.id) ||
    typeof v.status !== 'string' ||
    !['pending', 'provisioning', 'ready', 'failed', 'upgrading', 'deleting', 'deleted'].includes(
      v.status,
    ) ||
    typeof v.runtimeId !== 'string' ||
    v.runtimeId.length < 1 ||
    v.runtimeId.length > 256 ||
    typeof v.minimumCli !== 'string' ||
    !isCliVersion(v.minimumCli) ||
    typeof v.operationId !== 'string' ||
    v.operationId.length > 256 ||
    (v.error !== null && (typeof v.error !== 'string' || !/^[a-z0-9_]{1,64}$/.test(v.error)))
  )
    throw new Error('Invalid Juiced installation response');
  return v as unknown as InstallationMetadata;
}
export function readIdentity(v: unknown): AccountIdentity {
  if (
    !object(v) ||
    typeof v.userId !== 'string' ||
    typeof v.deviceId !== 'string' ||
    !Array.isArray(v.accounts) ||
    v.accounts.length > 100 ||
    v.accounts.some(
      (a) =>
        !object(a) ||
        typeof a.id !== 'string' ||
        !/^acc_[a-f0-9]{32}$/.test(a.id) ||
        typeof a.status !== 'string' ||
        typeof a.entitlement !== 'string',
    )
  )
    throw new Error('Invalid Juiced account response');
  return v as unknown as AccountIdentity;
}
