import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Project = { localDirectory: string; workspace: string };
type TerminalBinding = { identity: string; workspaceId: string };

function sessionPath(project: Project, terminal?: TerminalBinding) {
  const key = terminal ? JSON.stringify([project.workspace, terminal.workspaceId, terminal.identity]) : project.workspace;
  return join(project.localDirectory, '.cantelop', 'juiced', `${createHash('sha256').update(key).digest('hex')}.json`);
}

/** Select before Git preparation, then save only after preparation succeeds. */
export async function prepareAgentSession(project: Project, options: { resume?: boolean; explicit?: string; fresh?: boolean; terminal?: TerminalBinding } = {}) {
  if (options.fresh && (options.resume || options.explicit)) throw new Error('--new cannot be combined with --resume or --session.');
  const last = sessionPath(project);
  const path = options.terminal ? sessionPath(project, options.terminal) : last;
  let id = options.explicit;
  let resumed = Boolean(options.resume || id);
  if (!id && (options.resume || options.terminal && !options.fresh)) {
    try {
      const state = JSON.parse(await readFile(options.resume ? last : path, 'utf8')) as { workspace: string; id: string };
      if (state?.workspace !== project.workspace) throw new Error('Saved session belongs to another workspace');
      if (!/^ses_[a-f0-9]{32}$/.test(state.id)) throw new Error('Invalid saved Juiced session ID. Use juiced claude --new to start fresh.');
      id = state.id;
      resumed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.resume) throw new Error('No saved Juiced session for this workspace. Start one with juiced claude.');
    }
  }
  id ??= `ses_${randomUUID().replaceAll('-', '')}`;
  if (!/^ses_[a-f0-9]{32}$/.test(id)) throw new Error('Invalid Juiced session ID');
  const state = JSON.stringify({ workspace: project.workspace, id }) + '\n';
  return {
    id, resumed,
    async save() {
      await saveSession(path, state);
      if (path !== last) await saveSession(last, state);
    },
  };
}

/** A local pointer only; responses and native conversation state stay in the workspace. */
export async function agentSessionId(project: Project, resume = false, explicit?: string) {
  const session = await prepareAgentSession(project, { resume, ...(explicit !== undefined ? { explicit } : {}) });
  await session.save();
  return session.id;
}

async function saveSession(path: string, state: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(state); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
