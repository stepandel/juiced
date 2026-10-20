import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { WorkspaceRef, WorkspaceSelector } from '@cantelop/sdk';
import { discoverRepository } from './git.js';
import { selectProject } from './project.js';
import { SESSION_LIST_TIMEOUT_MS, validSessionId, validateSessionListPage, type SessionListCommand } from './session-list-protocol.js';
import type { TerminalCommand, TerminalEvent, TerminalReply } from './protocol.js';

type ListingApp = { workspace(selector: WorkspaceSelector): Pick<WorkspaceRef<TerminalCommand, TerminalEvent, TerminalReply>, 'inspect' | 'session'> };

async function localIdentities(project: { localDirectory: string; workspace: string }) {
  const directory = join(project.localDirectory, '.cantelop', 'juiced');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map<string, string>(); throw error; }
  const ids = new Map<string, string>();
  for (const entry of entries) if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) {
    try {
      const state = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
      if (state?.workspace === project.workspace && validSessionId(state.id)) ids.set(createHash('sha256').update(state.id).digest('hex'), state.id);
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return ids;
}

export async function listSessions(app: ListingApp, directory: string, workspaceOverride: string | undefined, signal: AbortSignal, stdout: Writable = process.stdout): Promise<void> {
  signal.throwIfAborted();
  const project = await selectProject(directory, workspaceOverride);
  const existing = await app.workspace({ slug: project.workspace }).inspect({ signal });
  signal.throwIfAborted();
  if (!existing) { stdout.write(`No saved sessions. Workspace ${project.workspace} does not exist.\n`); return; }
  if (existing.slug !== project.workspace || !/^wsp_[a-f0-9]{32}$/.test(existing.id)) throw new Error('Cantelop returned an invalid workspace identity.');
  const repository = await discoverRepository(project.localDirectory);
  const known = await localIdentities(project);
  const session = app.workspace({ id: existing.id }).session({ keepAliveSeconds: 0 });
  const combined = AbortSignal.any([signal, AbortSignal.timeout(SESSION_LIST_TIMEOUT_MS)]);
  const sessions: Array<{ id: string; updatedAt: string }> = [];
  let after: string | undefined, unidentified = 0, unreadable = 0;
  try {
    do {
      combined.throwIfAborted();
      const command: SessionListCommand = { type: 'sessions-list', directoryName: project.directoryName,
        ...(repository ? { git: { binding: repository.binding, relativeDirectory: repository.relativeDirectory } } : {}), ...(after ? { after } : {}) };
      const reply = await session.request(command, { signal: combined, timeoutMs: 30_000 });
      if (!reply?.ok || !reply.sessions) throw new Error(reply && !reply.ok ? reply.error : 'Session listing is unavailable. Build and deploy matching Juiced sources.');
      const page = validateSessionListPage(reply.sessions, after);
      for (const item of page.items) {
        const id = item.id ?? known.get(item.key);
        if (id) {
          if (createHash('sha256').update(id).digest('hex') !== item.key) throw new Error('The runtime returned an invalid session identity.');
          sessions.push({ id, updatedAt: item.updatedAt });
        } else unidentified++;
      }
      unreadable += page.unreadable;
      after = page.after;
    } while (after);
  } finally { await session.stop(); }
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  const lines = [`Sessions in ${project.workspace}:`];
  if (sessions.length) {
    lines.push('LAST UPDATED (UTC)    SESSION ID', ...sessions.map(item => `${new Date(item.updatedAt).toISOString().slice(0, 19).replace('T', ' ')}   ${item.id}`));
    lines.push('', `Reopen: juiced${workspaceOverride ? ` --workspace ${project.workspace}` : ''} claude --session ID`);
  } else lines.push('No saved sessions with a known Juiced ID.');
  if (unidentified) lines.push(`${unidentified} older ${unidentified === 1 ? 'history has' : 'histories have'} no saved Juiced ID. Reopen from the original tab to make ${unidentified === 1 ? 'it' : 'them'} discoverable.`);
  if (unreadable) lines.push(`${unreadable} ${unreadable === 1 ? 'history could' : 'histories could'} not be read.`);
  stdout.write(lines.join('\n') + '\n');
}
