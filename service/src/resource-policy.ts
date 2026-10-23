import { createHash } from 'node:crypto';

/** Limits projected for every entitled installation. */
export const ACCOUNT_LIMITS = {
  maxSandboxes: null,
  maxVcpus: null,
  maxMemoryMib: null,
  maxWorkspaces: 8,
  maxStorageBytes: 10 * 1024 ** 3,
} as const;

// Version the entitlement projection so ready installations receive policy changes
// during bootstrap and release promotion, even within the same billing period.
// Derived from the limits so changing them always reaches existing installations.
export const RESOURCE_POLICY_VERSION = createHash('sha256')
  .update(JSON.stringify(ACCOUNT_LIMITS))
  .digest('hex')
  .slice(0, 16);
/** An epoch is the billing period followed by this suffix; SQL appends it to `coalesce(period_id,'')`. */
export const POLICY_EPOCH_SUFFIX = `:${RESOURCE_POLICY_VERSION}`;
export function policyEpoch(periodId: string | null): string {
  return `${periodId ?? ''}${POLICY_EPOCH_SUFFIX}`;
}
