import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_CHUNK_BYTES, type FileInfo, type UploadManifest } from '../git-protocol.js';
import { fileInfo } from '../git.js';
import { isENOENT } from '../fs-util.js';

async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Create each file's durable part directory once, when the transfer begins. */
export async function prepareUploadParts(transfer: string, manifest: UploadManifest) {
  for (const info of manifest.files) await mkdir(join(transfer, `${info.name}.parts`), { recursive: true, mode: 0o700 });
  await syncDirectory(transfer);
}

/** Immutable parts can arrive in any order, including concurrent delivery retries. */
export async function saveUploadPart(transfer: string, info: FileInfo, offset: number, bytes: Buffer, signal: AbortSignal) {
  if (offset % UPLOAD_CHUNK_BYTES || bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, info.size - offset))
    throw new Error('Invalid transfer part');
  signal.throwIfAborted();
  const directory = join(transfer, `${info.name}.parts`);
  const temporary = join(directory, randomUUID() + '.tmp'), target = join(directory, String(offset));
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    signal.throwIfAborted();
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readFile(target)).equals(bytes)) throw new Error('Conflicting transfer retry');
    }
    await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}

/** Verify every part before exposing a complete artifact to either application path. */
export async function finishUpload(transfer: string, manifest: UploadManifest, signal: AbortSignal) {
  for (const info of manifest.files) {
    // A repeated finish after the parts were removed keeps the verified artifact.
    const existing = await fileInfo(join(transfer, info.name), info.name).catch(error => { if (isENOENT(error)) return undefined; throw error; });
    if (existing?.size === info.size && existing.sha256 === info.sha256) continue;
    const temporary = join(transfer, randomUUID() + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600), hash = createHash('sha256');
      try {
        for (let offset = 0; offset < info.size; offset += UPLOAD_CHUNK_BYTES) {
          signal.throwIfAborted();
          let bytes: Buffer;
          try { bytes = await readFile(join(transfer, `${info.name}.parts`, String(offset))); }
          catch (error) { if (isENOENT(error)) throw new Error('Incomplete or corrupt Git transfer'); throw error; }
          if (bytes.length !== Math.min(UPLOAD_CHUNK_BYTES, info.size - offset)) throw new Error('Incomplete or corrupt Git transfer');
          hash.update(bytes);
          await file.writeFile(bytes);
        }
        if (hash.digest('hex') !== info.sha256) throw new Error('Incomplete or corrupt Git transfer');
        await file.sync();
      } finally { await file.close(); }
      signal.throwIfAborted();
      await rename(temporary, join(transfer, info.name));
    } finally { await rm(temporary, { force: true }); }
  }
  await syncDirectory(transfer);
  // Assembled artifacts are durable; their parts would only double staging use.
  for (const info of manifest.files) await rm(join(transfer, `${info.name}.parts`), { recursive: true, force: true });
}
