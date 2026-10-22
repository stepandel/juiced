import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { readCliEvent, telemetryFromHeaders, type TelemetryContext, type CliEventProperties } from '../../contracts/telemetry';
import { authenticate } from './auth';
import { readText, ServiceError, type Config } from './config';
import { rateLimit } from './db';
import { logError } from './log';

type Event = { event: string; distinct_id: string; properties: Record<string, unknown> };
export class Telemetry {
  private key: string | undefined;
  private host: string;
  constructor(env: Record<string, string | undefined>, private fetcher: typeof fetch = fetch) {
    this.key = env.JUICED_POSTHOG_KEY;
    this.host = (env.JUICED_POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
    // A misconfigured analytics host disables collection instead of stopping the service.
    if (this.key && !['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(this.host)) {
      logError('telemetry.config', new Error('JUICED_POSTHOG_HOST must be the US or EU PostHog ingestion origin'));
      this.key = undefined;
    }
  }
  get enabled() { return !!this.key; }

  async capture(event: string, context: TelemetryContext, properties: CliEventProperties = {}, userId?: string) {
    if (!this.key) return false;
    const anonymous = `anonymous:${context.anonymousId}`;
    const distinct_id = userId ? `user:${userId}` : anonymous;
    const batch: Event[] = [];
    // Link the anonymous identity once at login or connection, not on every activity event.
    if (userId && event !== 'cli_session_active') batch.push({ event: '$identify', distinct_id, properties: { $anon_distinct_id: anonymous, $geoip_disable: true } });
    batch.push({ event, distinct_id, properties: {
      installation_id: context.installationId, cli_version: context.version,
      os: context.platform, arch: context.arch, ...properties,
      $geoip_disable: true, $process_person_profile: !!userId, source: 'juiced_cli',
    } });
    try {
      const response = await this.fetcher(new URL('/batch/', this.host), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(800),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.key, batch }),
      });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  }
  async receive(request: Request, pool: Pool, cfg: Config) {
    if (!this.enabled) return new Response(null, { status: 204 });
    const context = telemetryFromHeaders(request.headers);
    if (!context || request.headers.get('content-type') !== 'application/json')
      throw new ServiceError('invalid_telemetry');
    let input;
    try { input = readCliEvent(JSON.parse(await readText(request, 1024))); }
    catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError('invalid_telemetry'); }
    if (!input) throw new ServiceError('invalid_telemetry');
    const authenticated = input.event.startsWith('cli_session_');
    const identity = authenticated ? await authenticate(pool, cfg, request) : undefined;
    // The peer IP is set only by our Vercel ingress adapter, never taken from the event.
    const peer = request.headers.get('x-juiced-peer-ip');
    const key = identity ? `user:${identity.userId}` : peer ? createHash('sha256').update(peer).digest('hex') : context.installationId;
    await rateLimit(pool, `telemetry:${key}`, 60);
    const accepted = await this.capture(input.event, context, input.properties, identity?.userId);
    return new Response(null, { status: accepted ? 202 : 204 });
  }
}
