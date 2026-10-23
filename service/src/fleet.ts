import { fleet } from '../.cantelop/client/client.mjs';
import { required } from './config';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The CLI owns package selection; hosts receive its private integration document at process startup. */
export function configuredFleet(env: NodeJS.ProcessEnv, role: 'api' | 'worker') {
  const profile = env[role === 'worker' ? 'CANTELOP_WORKER_PROFILE' : 'CANTELOP_API_PROFILE'] ?? role;
  // The SDK resolves credentials from the process environment, so validate that same document.
  if (env.CANTELOP_APP_CONFIG !== process.env.CANTELOP_APP_CONFIG)
    throw new Error('CANTELOP_APP_CONFIG must match the process environment the Fleet SDK reads');
  let document: unknown;
  try { document = JSON.parse(required(env, 'CANTELOP_APP_CONFIG')); }
  catch { throw new Error('CANTELOP_APP_CONFIG must contain a private Fleet integration document'); }
  const selected = record(document) && document.schemaVersion === 1 && record(document.profiles) && Object.hasOwn(document.profiles, profile) ? document.profiles[profile] : undefined;
  const bindings = record(selected) && Array.isArray(selected.fleets) ? selected.fleets : [];
  const binding = bindings.find((item: unknown) => record(item) && item.name === fleet.name);
  if (!record(binding) || typeof binding.packageId !== 'string' || !/^pkg_[a-f0-9]{32}$/.test(binding.packageId) || !fleet.runtimeId || binding.runtimeId !== fleet.runtimeId)
    throw new Error(`Fleet profile ${profile} must contain CLI-selected deployment metadata matching the compiled Juiced runtime`);
  return { fleet: fleet.withProfile(profile), packageId: binding.packageId, runtimeId: fleet.runtimeId };
}
