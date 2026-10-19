import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A local pointer only; responses and native conversation state stay in the workspace. */
export async function agentSessionId(project: { localDirectory: string; workspace: string }, resume = false, explicit?: string) {
  const path = join(project.localDirectory, '.cantelop', 'juiced', `${createHash('sha256').update(project.workspace).digest('hex')}.json`);
  let id = explicit;
  if (resume && !id) {
    try {
      const state = JSON.parse(await readFile(path, 'utf8')) as { workspace: string; id: string };
      if (state.workspace !== project.workspace) throw new Error('Saved session belongs to another workspace');
      id = state.id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No saved Juiced session for this workspace. Start one with juiced claude.');
      throw error;
    }
  }
  id ??= `ses_${randomUUID().replaceAll('-', '')}`;
  if (!/^ses_[a-f0-9]{32}$/.test(id)) throw new Error('Invalid Juiced session ID');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ workspace: project.workspace, id }) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
  return id;
}
