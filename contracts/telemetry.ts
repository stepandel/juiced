import { isCliVersion } from './cli-version.ts';

export const TELEMETRY_HEADER = 'X-Juiced-Telemetry';
export interface TelemetryContext {
  installationId: string;
  anonymousId: string;
  version: string;
  platform: string;
  arch: string;
}
export type CliEvent = 'cli_installed' | 'cli_first_run' | 'cli_session_connected' | 'cli_session_active';
export type CliEventProperties = { install_kind?: 'fresh' | 'update'; session_mode?: 'interactive' | 'terminal' };
export const telemetryId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** Reject unknown fields so accidental command arguments or content cannot pass through. */
export function readTelemetryContext(value: unknown): TelemetryContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['installationId', 'anonymousId', 'version', 'platform', 'arch'].includes(k)) ||
    !telemetryId(v.installationId) || !telemetryId(v.anonymousId) ||
    typeof v.version !== 'string' || v.version.length > 64 || !isCliVersion(v.version) ||
    !['darwin', 'linux', 'win32'].includes(String(v.platform)) ||
    !['arm64', 'x64'].includes(String(v.arch))) return;
  return v as unknown as TelemetryContext;
}

export function telemetryFromHeaders(headers: Headers) {
  const raw = headers.get(TELEMETRY_HEADER);
  if (!raw || raw.length > 512) return;
  try { return readTelemetryContext(JSON.parse(raw)); } catch { return; }
}

export function readCliEvent(value: unknown): { event: CliEvent; properties: CliEventProperties } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['event', 'properties'].includes(k))) return;
  const p = v.properties;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return;
  const properties = p as Record<string, unknown>;
  if (v.event === 'cli_installed' && Object.keys(properties).length === 1 &&
    ['fresh', 'update'].includes(String(properties.install_kind)))
    return { event: v.event, properties: properties as CliEventProperties };
  if (v.event === 'cli_first_run' && Object.keys(properties).length === 0)
    return { event: v.event, properties: {} };
  if (['cli_session_connected', 'cli_session_active'].includes(String(v.event)) &&
    Object.keys(properties).length === 1 && ['interactive', 'terminal'].includes(String(properties.session_mode)))
    return { event: v.event as CliEvent, properties: properties as CliEventProperties };
}
