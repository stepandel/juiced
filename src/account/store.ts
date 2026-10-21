import { readFileSync, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

export interface Credentials {
  origin: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account?: string;
}
export interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export class CredentialStore {
  readonly path: string;
  constructor(
    readonly origin: string,
    private env: NodeJS.ProcessEnv = process.env,
    private keyringFactory?: () => Promise<KeyringEntry | undefined>,
  ) {
    const root = configRoot(env);
    this.path = join(root, createHash('sha256').update(origin).digest('hex') + '.json');
  }
  async read(): Promise<Credentials | undefined> {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 32 * 1024 ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw new Error('Juiced credential file must be private.');
      let text = await file.readFile('utf8');
      const metadata = parsePrivateJSON(text) as { storage?: string; origin?: string };
      if (metadata.storage === 'keyring') {
        if (metadata.origin !== this.origin) throw new Error('Invalid credential origin.');
        const entry = await this.keyring();
        if (!entry) throw new Error('OS credential store is unavailable. Unlock it and retry.');
        const secret = await entry.getPassword();
        if (!secret) throw new Error('Juiced credential is missing. Sign in again.');
        text = secret;
      }
      const v = parsePrivateJSON(text) as unknown as Credentials;
      if (
        v.origin !== this.origin ||
        typeof v.accessToken !== 'string' ||
        typeof v.refreshToken !== 'string' ||
        !Number.isFinite(v.expiresAt) ||
        !/^[A-Za-z0-9_-]{20,512}$/.test(v.accessToken) ||
        !/^[A-Za-z0-9_-]{20,512}$/.test(v.refreshToken) ||
        (v.account !== undefined && !/^acc_[a-f0-9]{32}$/.test(v.account))
      )
        throw new Error('Invalid Juiced credentials. Sign in again.');
      return v;
    } finally {
      await file.close();
    }
  }
  async write(value: Credentials) {
    if (
      value.origin !== this.origin ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(value.accessToken) ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(value.refreshToken) ||
      !Number.isFinite(value.expiresAt)
    )
      throw new Error('Invalid Juiced credentials. Sign in again.');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let serialized = JSON.stringify(value);
    let existingKeyring = false;
    try {
      existingKeyring =
        (parsePrivateJSON(await readFile(this.path, 'utf8')) as { storage?: string }).storage ===
        'keyring';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entry = await this.keyring();
    try {
      if (entry) {
        await entry.setPassword(serialized);
        serialized = JSON.stringify({ origin: this.origin, storage: 'keyring' });
      } else if (existingKeyring) throw new Error('OS credential store is unavailable.');
    } catch (error) {
      if (existingKeyring) throw error;
      process.stderr.write(
        'Juiced is using a private credential file because the OS credential store is unavailable.\n',
      );
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(serialized + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async keyring(): Promise<KeyringEntry | undefined> {
    if (this.env.JUICED_CREDENTIAL_STORE === 'file') return;
    if (this.keyringFactory) return this.keyringFactory();
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      return new AsyncEntry('juiced', createHash('sha256').update(this.origin).digest('hex'), {
        linux: { store: 'secret-service' },
      });
    } catch {
      return;
    }
  }
  async clear() {
    let metadata;
    try {
      metadata = parsePrivateJSON(await readFile(this.path, 'utf8')) as { storage?: string };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (metadata?.storage === 'keyring') {
      const entry = await this.keyring();
      if (!entry) throw new Error('Unlock the OS credential store to remove Juiced credentials.');
      await entry.deletePassword();
    }
    await rm(this.path, { force: true });
  }
  async locked<T>(
    signal: AbortSignal,
    action: () => Promise<T>,
    purpose: 'credentials' | 'login' = 'credentials',
  ): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = this.path + (purpose === 'login' ? '.login.lock' : '.lock');
    const until = Date.now() + (purpose === 'login' ? 600000 : 30000);
    for (;;) {
      signal.throwIfAborted();
      try {
        const lock = await open(path, 'wx', 0o600);
        await lock.writeFile(String(process.pid));
        await lock.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Elect one reaper before reading an owner. Two reapers must never
        // both observe a dead PID and unlink a newly acquired replacement.
        let reaper;
        try {
          reaper = await open(path + '.reap', 'wx', 0o600);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          // A reaper holds its file for milliseconds; an old one was abandoned by a crash.
          if (await abandoned(path + '.reap')) await rm(path + '.reap', { force: true });
        }
        if (reaper)
          try {
            const pid = Number(await readFile(path, 'utf8').catch(() => ''));
            if (Number.isSafeInteger(pid) && pid > 0) {
              try {
                process.kill(pid, 0);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ESRCH') await rm(path, { force: true });
              }
            } else if (await abandoned(path)) {
              // The owner crashed between creating the lock and recording its PID.
              await rm(path, { force: true });
            }
          } finally {
            await reaper.close();
            await rm(path + '.reap', { force: true });
          }
        if (Date.now() > until)
          throw new Error(
            `Another Juiced process is ${purpose === 'login' ? 'signing in' : 'refreshing credentials'}. Retry shortly.`,
          );
        await delay(100, undefined, { signal });
      }
    }
    try {
      return await action();
    } finally {
      await rm(path, { force: true });
    }
  }
}

async function abandoned(path: string) {
  try {
    return (await stat(path)).mtimeMs < Date.now() - 5000;
  } catch {
    return false;
  }
}

export function configRoot(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.JUICED_CONFIG_HOME ??
    join(
      process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.platform === 'win32'
          ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
          : (env.XDG_CONFIG_HOME ?? join(homedir(), '.config')),
      'juiced',
    )
  );
}
export function savedOrigin(env: NodeJS.ProcessEnv) {
  try {
    const text = readFileSync(join(configRoot(env), 'service.json'), 'utf8');
    if (text.length > 4096) return;
    const v = JSON.parse(text) as { origin?: unknown };
    return typeof v.origin === 'string' ? v.origin : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Invalid Juiced service configuration. Set JUICED_SERVICE_URL.');
  }
}
export async function rememberOrigin(origin: string, env: NodeJS.ProcessEnv) {
  const root = configRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'service.json'),
    temp = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ origin }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function parsePrivateJSON(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {}
  throw new Error('Invalid Juiced credential file. Sign in again.');
}
