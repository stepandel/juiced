import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export const isENOENT = (error: unknown) => (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT';

/**
 * Replace `path` so readers see either the old or the new contents, and a crash
 * after return keeps the new ones. Unique temporaries let concurrent writers race
 * without corrupting each other; the last rename wins. Private (0600) by default.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, options: { mode?: number; signal?: AbortSignal } = {}): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', options.mode ?? 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    options.signal?.throwIfAborted();
    await rename(temporary, path);
    // Persist the rename itself. Some platforms and filesystems cannot fsync a directory.
    try {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EBADF'].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  } finally { await rm(temporary, { force: true }); }
}
