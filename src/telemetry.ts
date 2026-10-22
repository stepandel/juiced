import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { configRoot } from './account/store.js';
import { withFileLock } from './file-lock.js';
import { writeFileAtomic } from './fs-util.js';
import { VERSION } from './version.js';
import { TELEMETRY_HEADER, telemetryId, type CliEvent, type CliEventProperties, type TelemetryContext } from '../contracts/telemetry.js';

interface State {
  installationId: string;
  anonymousId: string;
  disabled?: boolean;
  noticeShown?: boolean;
  firstRunSent?: boolean;
}
const notice = 'Juiced collects basic install and usage events when service analytics is enabled (version, OS, and session activity). No prompts, code, or terminal output. Opt out: juiced telemetry disable or JUICED_TELEMETRY_DISABLED=1. Details: https://juiced.codes/docs/telemetry\n';

/** Best-effort telemetry. No SDK, background daemon, or durable event queue. */
export class CliTelemetry {
  readonly path: string;
  private pending = new Set<Promise<unknown>>();
  private cached: { context: TelemetryContext; until: number } | undefined;
  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    private fetcher: typeof fetch = fetch,
    private output: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
  ) { this.path = join(configRoot(env), 'telemetry.json'); }

  private excluded() {
    return this.env.JUICED_MODE === 'self-managed' || this.env.JUICED_TELEMETRY_DISABLED === '1' ||
      this.env.DO_NOT_TRACK === '1' || (!!this.env.CI && this.env.CI !== 'false' && this.env.CI !== '0');
  }
  private async read(): Promise<State | undefined> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new Error('Invalid telemetry settings');
      const s = JSON.parse(await file.readFile('utf8')) as State;
      if (!telemetryId(s?.installationId) || !telemetryId(s.anonymousId) ||
        ['disabled', 'noticeShown', 'firstRunSent'].some(k => (s as unknown as Record<string, unknown>)[k] !== undefined && typeof (s as unknown as Record<string, unknown>)[k] !== 'boolean'))
        throw new Error('Invalid telemetry settings');
      return s;
    } finally { await file.close(); }
  }
  private locked<T>(action: () => Promise<T>) {
    return withFileLock(this.path + '.lock', AbortSignal.timeout(300), action, 250, 'Telemetry settings busy');
  }
  private async context(): Promise<TelemetryContext | undefined> {
    if (this.excluded()) return;
    if (this.cached && this.cached.until > Date.now()) return this.cached.context;
    try {
      // Runtime input requests should not read settings from disk for every keystroke.
      const metadata = (s: State) => {
        const context = { installationId: s.installationId, anonymousId: s.anonymousId, version: VERSION, platform: process.platform, arch: process.arch };
        this.cached = { context, until: Date.now() + 1000 };
        return context;
      };
      const saved = await this.read();
      if (saved?.disabled) return;
      if (saved?.noticeShown) return metadata(saved);
      return await this.locked(async () => {
        const s = await this.read() ?? { installationId: randomUUID(), anonymousId: randomUUID() };
        if (s.disabled) return;
        if (!s.noticeShown) {
          this.output.write(notice);
          s.noticeShown = true;
          await writeFileAtomic(this.path, JSON.stringify(s) + '\n');
        }
        return metadata(s);
      });
    } catch { return; }
  }
  async headers(): Promise<Record<string, string>> {
    const context = await this.context();
    return context ? { [TELEMETRY_HEADER]: JSON.stringify(context) } : {};
  }
  // Unreadable settings send no metadata, so report them as disabled.
  async enabled() { return !this.excluded() && !(await this.read().catch(() => ({ disabled: true })))?.disabled; }
  async preference(enabled: boolean) {
    this.cached = undefined;
    await this.locked(async () => {
      // Corrupt settings are replaced so the documented command can always recover.
      const s = await this.read().catch(() => undefined) ?? { installationId: randomUUID(), anonymousId: randomUUID() };
      // Re-enabling starts a new anonymous identity; the installation count stays stable.
      if (enabled && s.disabled) { s.anonymousId = randomUUID(); s.noticeShown = false; }
      s.disabled = !enabled;
      await writeFileAtomic(this.path, JSON.stringify(s) + '\n');
    });
    this.cached = undefined;
  }
  async resetIdentity() {
    this.cached = undefined;
    try {
      await this.locked(async () => {
        const s = await this.read();
        if (s) await writeFileAtomic(this.path, JSON.stringify({ ...s, anonymousId: randomUUID() }) + '\n');
      });
    } catch { /* Account sign-out must work even if analytics settings cannot be written. */ }
  }
  schedule(action: () => Promise<unknown>) {
    const pending = action().catch(() => {});
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }
  async flush(timeoutMs = 1500) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>(r => { timer = setTimeout(r, timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  async capture(origin: string, event: CliEvent, properties: CliEventProperties = {}, token?: string) {
    try {
      const headers = await this.headers();
      if (!headers[TELEMETRY_HEADER]) return false;
      const response = await this.fetcher(new URL('/v1/telemetry', origin), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1200),
        headers: { ...headers, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ event, properties }),
      });
      await response.body?.cancel();
      return response.status === 202;
    } catch { return false; }
  }
  firstRun(origin: string) {
    this.schedule(async () => {
      if (this.excluded()) return;
      // Hold the lock across this one-time event to deduplicate concurrent terminal tabs.
      const context = await this.context();
      if (!context) return;
      await withFileLock(this.path + '.first-run.lock', AbortSignal.timeout(1500), async () => {
        const s = await this.read();
        if (!s || s.disabled || s.firstRunSent) return;
        const response = await this.fetcher(new URL('/v1/telemetry', origin), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1200),
          headers: { [TELEMETRY_HEADER]: JSON.stringify(context), 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'cli_first_run', properties: {} }),
        });
        await response.body?.cancel();
        if (response.status === 202) await this.locked(async () => {
          const current = await this.read();
          if (current && current.anonymousId === context.anonymousId)
            await writeFileAtomic(this.path, JSON.stringify({ ...current, firstRunSent: true }) + '\n');
        });
      }, 1400, 'First run is being reported');
    });
  }
}
