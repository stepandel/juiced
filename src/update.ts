import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { cliVersionAtLeast, isCliVersion } from '../contracts/cli-version.js';
import { VERSION } from './version.js';
import { withFileLock } from './file-lock.js';

declare const JUICED_INSTALLER_SOURCE: string;
const releases = 'https://github.com/stepandel/juiced/releases';
export const MANUAL_UPDATE = 'curl -fsSL https://juiced.codes/install.sh | sh';
const retryMarker = 'JUICED_UPDATE_ATTEMPTED';

interface Installation {
  installDir: string;
  binDir: string;
  command: string;
}
interface UpdateOptions {
  env?: NodeJS.ProcessEnv;
  entry?: string;
  version?: string;
  fetcher?: typeof fetch;
  installer?: string;
  write?: (text: string) => void;
  serviceOrigin?: string;
}

/** Only installer-owned releases may replace themselves. Source/npm installs
 * have no release metadata and must keep using their own installation method. */
export class CliUpdater {
  private readonly env: NodeJS.ProcessEnv;
  private readonly version: string;
  private readonly write: (text: string) => void;
  private attempted = false;
  constructor(private readonly options: UpdateOptions = {}) {
    this.env = options.env ?? process.env;
    this.version = options.version ?? VERSION;
    this.write = options.write ?? (text => { process.stderr.write(text); });
  }

  async check(signal: AbortSignal, reason: 'startup' | 'manual' | 'mismatch' = 'startup'): Promise<string | undefined> {
    const required = reason !== 'startup';
    let target: string | undefined;
    try {
      if (this.env[retryMarker] || this.attempted) {
        if (required) throw new Error('An update was already attempted for this command. The CLI and service runtime still differ; retry after the matching release is available.');
        return;
      }
      const installation = await this.installation();
      if (!installation) {
        if (required) throw new Error('This is a source or package-manager installation. Update it using the same installation method (for a source checkout, run npm install and npm run build), or install the published CLI.');
        return;
      }
      const version = await this.targetVersion(signal);
      target = version;
      if (cliVersionAtLeast(this.version, version)) {
        if (reason === 'mismatch') throw new Error(`Juiced ${this.version} is already at or ahead of the service's recommended release (${version}), but the service runtime differs. Retry after the matching service/CLI release is available.`);
        if (reason === 'manual') this.write(`juiced: Juiced ${this.version} is up to date.\n`);
        return;
      }
      const installer = this.options.installer ??
        (typeof JUICED_INSTALLER_SOURCE === 'string' ? JUICED_INSTALLER_SOURCE : undefined);
      if (!installer) throw new Error('This build does not contain the release installer.');
      this.attempted = true;
      return await withFileLock(join(installation.installDir, 'update.lock'), signal, async () => {
        // Another terminal may have completed the same update while we waited.
        const activeRoot = dirname(dirname(await realpath(installation.command)));
        const active = JSON.parse(await readFile(join(activeRoot, 'release.json'), 'utf8'));
        if (cliVersionAtLeast(active.version, version)) return installation.command;
        this.write(`juiced: Updating ${this.version} → ${version}…\n`);
        await new Promise<void>((accept, reject) => {
          const child = spawn('/bin/sh', ['-s', '--', version], {
            env: { ...this.env, JUICED_INSTALL_DIR: installation.installDir, JUICED_BIN_DIR: installation.binDir },
            // The installer reads its embedded source, never the user's piped input.
            stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
          });
          child.stdout.on('data', chunk => this.write(String(chunk)));
          child.stderr.on('data', chunk => this.write(String(chunk)));
          child.on('error', reject);
          child.on('close', code => code === 0 ? accept() : reject(new Error('The release installer failed; the previous CLI has been kept.')));
          child.stdin.on('error', () => {}); // A failed shell may close stdin early.
          child.stdin.end(installer);
        });
        const installedRoot = dirname(dirname(await realpath(installation.command)));
        const installed = JSON.parse(await readFile(join(installedRoot, 'release.json'), 'utf8'));
        if (!cliVersionAtLeast(installed.version, version))
          throw new Error('The installed CLI does not match the requested release.');
        return installation.command;
      }, 180000, 'Another Juiced process is updating. Run your command again shortly.');
    } catch (error) {
      signal.throwIfAborted();
      const detail = error instanceof Error ? error.message : 'Update unavailable.';
      const message = `${detail}\nUpdate manually: juiced update\nOr reinstall: ${MANUAL_UPDATE}${target ? ` -s -- ${target}` : ''}`;
      if (required) throw new Error(message);
      this.write(`juiced: Automatic update unavailable. ${message}\n`);
    }
  }

  private async targetVersion(signal: AbortSignal): Promise<string> {
    const fetcher = this.options.fetcher ?? fetch;
    if (this.options.serviceOrigin) {
      const response = await fetcher(new URL('/v1/config', this.options.serviceOrigin), {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      // Older services don't advertise a release. Preserve their GitHub fallback.
      if (response.ok) {
        const config = await response.json() as { cliVersion?: unknown };
        if (config.cliVersion !== undefined) {
          if (typeof config.cliVersion !== 'string' || !isCliVersion(config.cliVersion))
            throw new Error('The service advertised an invalid CLI release.');
          return config.cliVersion;
        }
      } else if (response.status !== 404) {
        throw new Error(`Could not check the service's CLI release (HTTP ${response.status}).`);
      }
    }
    const response = await fetcher(`${releases}/latest`, {
      method: 'HEAD', redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    const url = new URL(response.url);
    const version = url.pathname.slice('/stepandel/juiced/releases/tag/v'.length);
    if (!response.ok || url.origin !== 'https://github.com' ||
        !url.pathname.startsWith('/stepandel/juiced/releases/tag/v') ||
        !isCliVersion(version) || version.includes('-'))
      throw new Error('Could not resolve the latest stable Juiced release.');
    return version;
  }

  private async installation(): Promise<Installation | undefined> {
    const entry = this.options.entry ?? process.argv[1];
    if (!entry) return;
    const root = dirname(dirname(await realpath(entry)));
    let release;
    try {
      release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (release.version !== this.version || release.platform !== process.platform ||
        release.arch !== process.arch || basename(dirname(root)) !== 'releases') return;
    const installDir = dirname(dirname(root));
    let binDir = this.env.JUICED_BIN_DIR ?? join(this.env.HOME ?? homedir(), '.local/bin');
    try {
      const paths = (await readFile(join(root, 'install-paths'), 'utf8')).split('\0');
      if (paths.length !== 3 || !paths[0]?.startsWith('/') ||
          await realpath(paths[0]) !== installDir || !paths[1]?.startsWith('/'))
        throw new Error('Invalid Juiced installation paths.');
      binDir = paths[1];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const command = join(binDir, 'juiced');
    // Refuse to replace an unrelated command, including another install prefix.
    const target = await realpath(command);
    if (dirname(dirname(dirname(target))) !== join(installDir, 'releases'))
      throw new Error('The Juiced command is not owned by this installation.');
    return { installDir, binDir, command };
  }

  /** Restart only before command execution; callers must not replay side effects. */
  restart(command: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    const env = { ...this.env, [retryMarker]: this.version };
    // Official releases bundle Node 24. Replacing the process preserves the
    // shell parent used for terminal/session identity, stdin and signal behavior.
    if (process.execve) process.execve(command, [command, ...process.argv.slice(2)], env);
    return new Promise((accept, reject) => {
      const child = spawn(command, process.argv.slice(2), {
        env, stdio: 'inherit', signal,
      });
      child.on('error', reject);
      child.on('exit', (code, killed) => accept(code ?? (killed === 'SIGINT' ? 130 : killed === 'SIGHUP' ? 129 : 143)));
    });
  }
}

export function needsCliUpdate(error: unknown): boolean {
  // The SDK wraps transport failures as command_outcome_unknown. Retain the
  // actionable service error without treating unrelated failures as upgrades.
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    const value = error as { code?: unknown; cause?: unknown };
    if (value.code === 'cli_upgrade_required' || value.code === 'session_runtime_mismatch') return true;
    error = value.cause;
  }
  return false;
}
