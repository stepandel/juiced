import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_PAGE_SIZE, validSessionId, validSessionKey, validateSessionListCommand, type SessionListCommand, type SessionListPage } from '../session-list-protocol.js';
import { isENOENT, writeFileAtomic } from '../fs-util.js';

export const sessionKey = (id: string) => createHash('sha256').update(id).digest('hex');

/** Save the reversible identity beside the hashed history, including on legacy reattachment. */
export async function saveSessionIdentity(directory: string, id: string) {
  if (!validSessionId(id)) return;
  await writeFileAtomic(join(directory, 'identity.json'), JSON.stringify({ version: 1, id }) + '\n');
}

async function identity(directory: string, key: string) {
  let file;
  try {
    file = await open(join(directory, 'identity.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024) return undefined;
    const saved = JSON.parse(await file.readFile('utf8')) as { version?: number; id?: string };
    return saved?.version === 1 && validSessionId(saved.id) && sessionKey(saved.id) === key ? saved.id : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) return undefined;
    throw error;
  } finally { await file?.close(); }
}

/** Only the launch configuration is needed; never replay, repair, or start the conversation. */
async function header(directory: string, signal: AbortSignal) {
  const file = await open(join(directory, 'events.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size) return undefined;
    const buffer = Buffer.alloc(16 * 1024);
    let pending = Buffer.alloc(0), offset = 0;
    while (offset < Math.min(info.size, 1024 * 1024)) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        const record = JSON.parse(pending.subarray(0, end).toString('utf8'));
        pending = pending.subarray(end + 1);
        if (record?.kind === 'configuration') return { command: record.command, updatedAt: info.mtime.toISOString() };
      }
    }
    if (offset >= 1024 * 1024) throw new Error('Session configuration is too large');
    return undefined;
  } finally { await file.close(); }
}

export async function listRemoteSessions(command: SessionListCommand, signal: AbortSignal, workspace = process.cwd()): Promise<SessionListPage> {
  validateSessionListCommand(command);
  signal.throwIfAborted();
  const root = join(workspace, '.juiced', 'sessions');
  let entries;
  try {
    for (const path of [join(workspace, '.juiced'), root]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The session history directory is unsafe.');
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return { items: [], unreadable: 0 };
    throw error;
  }
  const keys = entries.filter(entry => entry.isDirectory() && validSessionKey(entry.name) && entry.name > (command.after ?? '')).map(entry => entry.name).sort();
  const page: SessionListPage = { items: [], unreadable: 0 };
  for (const key of keys.slice(0, SESSION_PAGE_SIZE)) {
    signal.throwIfAborted();
    try {
      const directory = join(root, key), saved = await header(directory, signal);
      if (!saved || saved.command?.type !== 'start' || saved.command.directoryName !== command.directoryName ||
          saved.command.git?.binding !== command.git?.binding || saved.command.git?.relativeDirectory !== command.git?.relativeDirectory) continue;
      const id = await identity(directory, key);
      page.items.push({ key, ...(id ? { id } : {}), updatedAt: saved.updatedAt });
    } catch (error) {
      if (signal.aborted) throw error;
      if (!isENOENT(error)) page.unreadable++;
    }
  }
  if (keys.length > SESSION_PAGE_SIZE) page.after = keys[SESSION_PAGE_SIZE - 1]!;
  return page;
}
