import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateSavedSettings, type SavedSettings } from '../settings.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Save in Claude's user settings, outside the project directory. */
export async function saveSettings(workspace: string, patch: SavedSettings, signal: AbortSignal): Promise<void> {
  validateSavedSettings(patch);
  const directory = join(workspace, '.claude');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.juiced-settings-lock');
  // Sessions have separate runtime processes but share this filesystem.
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt >= 50) throw new Error('Settings are locked by another save. Retry, or remove .claude/.juiced-settings-lock in the remote workspace if a previous save was interrupted.');
      await delay(100, undefined, { signal });
    }
  }
  const path = join(directory, 'settings.json');
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    let settings: unknown = {};
    try { settings = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!record(settings)) throw new Error('Claude settings.json must contain a JSON object');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'permissionMode') {
        if (settings.permissions !== undefined && !record(settings.permissions)) throw new Error('Claude settings permissions must contain a JSON object');
        settings.permissions = { ...settings.permissions as Record<string, unknown> | undefined, defaultMode: value };
      } else settings[key] = value;
    }
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(settings, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}
