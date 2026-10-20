import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateSavedSettings, type SavedSettings } from '../settings.js';
import { isENOENT, writeFileAtomic } from '../fs-util.js';
import { isRecord as record } from '../agent-protocol.js';

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
  try {
    let settings: unknown = {};
    try { settings = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (!isENOENT(error)) throw error; }
    if (!record(settings)) throw new Error('Claude settings.json must contain a JSON object');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'permissionMode') {
        if (settings.permissions !== undefined && !record(settings.permissions)) throw new Error('Claude settings permissions must contain a JSON object');
        settings.permissions = { ...settings.permissions as Record<string, unknown> | undefined, defaultMode: value };
      } else settings[key] = value;
    }
    await writeFileAtomic(path, JSON.stringify(settings, null, 2) + '\n', { signal });
  } finally { await rm(lock, { recursive: true, force: true }); }
}
