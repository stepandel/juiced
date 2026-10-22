import { readFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock } from '../file-lock.js';
import { writeFileAtomic } from '../fs-util.js';

export interface Credentials {
  origin: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account?: string;
}
export class CredentialStore {
  readonly path: string;
  /**
   * Releases up to 0.2.3 share this path and rewrite it with an OS-keyring
   * pointer on every token refresh. A still-running older process would sign
   * out newer ones, so current releases keep their own file beside it.
   */
  readonly legacyPath: string;
  constructor(
    readonly origin: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const root = configRoot(env);
    const name = createHash('sha256').update(origin).digest('hex') + '.json';
    this.legacyPath = join(root, name);
    this.path = join(root, 'credentials', name);
  }
  async read(): Promise<Credentials | undefined> {
    const current = await readCredentialFile(this.path, this.origin);
    if (current.kind === 'credentials') return current.value;
    if (current.kind === 'keyring') throw new Error('Invalid Juiced credential file. Sign in again.');
    // Another process may have moved the legacy file since our first read.
    // Recheck both locations under the migration lock before reporting sign-out.
    return withFileLock(this.legacyPath + '.lock', new AbortController().signal, async () => {
      const raced = await readCredentialFile(this.path, this.origin);
      if (raced.kind === 'credentials') return raced.value;
      if (raced.kind === 'keyring') throw new Error('Invalid Juiced credential file. Sign in again.');
      const legacy = await readCredentialFile(this.legacyPath, this.origin);
      // Legacy keyring pointers renew sign-in without opening the OS store.
      if (legacy.kind !== 'credentials') return;
      // Move rather than copy: refresh tokens rotate and must have one owner.
      await this.write(legacy.value);
      await rm(this.legacyPath, { force: true });
      return legacy.value;
    }, 30000, 'Another Juiced process is refreshing credentials. Retry shortly.');
  }
  async write(value: Credentials) {
    if (
      value.origin !== this.origin ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(value.accessToken) ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(value.refreshToken) ||
      !Number.isFinite(value.expiresAt) ||
      (value.account !== undefined && !/^acc_[a-f0-9]{32}$/.test(value.account))
    )
      throw new Error('Invalid Juiced credentials. Sign in again.');
    await privateDirectory(dirname(this.path));
    await writeFileAtomic(this.path, JSON.stringify(value) + '\n');
  }
  async clear() {
    await rm(this.path, { force: true });
    await rm(this.legacyPath, { force: true });
  }
  async locked<T>(
    signal: AbortSignal,
    action: () => Promise<T>,
    purpose: 'credentials' | 'login' = 'credentials',
  ): Promise<T> {
    signal.throwIfAborted();
    await privateDirectory(dirname(this.path));
    return withFileLock(
      this.path + (purpose === 'login' ? '.login.lock' : '.lock'), signal, action,
      purpose === 'login' ? 600000 : 30000,
      `Another Juiced process is ${purpose === 'login' ? 'signing in' : 'refreshing credentials'}. Retry shortly.`,
    );
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
  await privateDirectory(root);
  await writeFileAtomic(join(root, 'service.json'), JSON.stringify({ origin }) + '\n');
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

type CredentialFile =
  | { kind: 'missing' }
  | { kind: 'keyring' }
  | { kind: 'credentials'; value: Credentials };

async function readCredentialFile(path: string, origin: string): Promise<CredentialFile> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
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
    const value = parsePrivateJSON(await file.readFile('utf8'));
    if (value.storage === 'keyring') {
      if (value.origin !== origin) throw new Error('Invalid credential origin.');
      return { kind: 'keyring' };
    }
    const v = value as unknown as Credentials;
    if (
      v.origin !== origin ||
      typeof v.accessToken !== 'string' ||
      typeof v.refreshToken !== 'string' ||
      !Number.isFinite(v.expiresAt) ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(v.accessToken) ||
      !/^[A-Za-z0-9_-]{20,512}$/.test(v.refreshToken) ||
      (v.account !== undefined && !/^acc_[a-f0-9]{32}$/.test(v.account))
    )
      throw new Error('Invalid Juiced credentials. Sign in again.');
    return { kind: 'credentials', value: v };
  } finally {
    await file.close();
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
