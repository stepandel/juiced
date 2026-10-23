// Version the entitlement projection so ready installations receive policy changes
// during bootstrap and release promotion, even within the same billing period.
export const RESOURCE_POLICY_VERSION = 'unlimited-compute-v1';
export function policyEpoch(periodId: string | null): string {
  return `${periodId ?? ''}:${RESOURCE_POLICY_VERSION}`;
}
