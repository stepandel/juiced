import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** PID-owned lock with serialized crash recovery, shared by credentials and updates. */
export async function withFileLock<T>(
  path: string, signal: AbortSignal, action: () => Promise<T>,
  timeout: number, busy: string,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const until = Date.now() + timeout;
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
      if (Date.now() > until) throw new Error(busy);
      await delay(100, undefined, { signal });
    }
  }
  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
}

async function abandoned(path: string) {
  try {
    return (await stat(path)).mtimeMs < Date.now() - 5000;
  } catch {
    return false;
  }
}

