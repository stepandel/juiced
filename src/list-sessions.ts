import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { WorkspaceRef, WorkspaceSelector } from '@cantelop/sdk';
import { discoverRepository, sha256 } from './git.js';
import { selectProject } from './project.js';
import { isENOENT } from './fs-util.js';
import { ADMISSION_RETRY_MS, retryAdmission } from './transport.js';
import { SESSION_LIST_TIMEOUT_MS, validSessionId, validateSessionListPage, type SessionListCommand } from './session-list-protocol.js';
import { validWorkspaceId, type TerminalCommand, type TerminalEvent, type TerminalReply } from './protocol.js';

type ListingApp = { workspace(selector: WorkspaceSelector): Pick<WorkspaceRef<TerminalCommand, TerminalEvent, TerminalReply>, 'inspect' | 'session'> };

async function localIdentities(project: { localDirectory: string; workspace: string }) {
  const directory = join(project.localDirectory, '.cantelop', 'juiced');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (isENOENT(error)) return new Map<string, string>(); throw error; }
  const ids = new Map<string, string>();
  for (const entry of entries) if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) {
    try {
      const state = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
      if (state?.workspace === project.workspace && validSessionId(state.id)) ids.set(sha256(state.id), state.id);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isENOENT(error)) throw error;
    }
  }
  return ids;
}

export async function listSessions(app: ListingApp, directory: string, workspaceOverride: string | undefined, signal: AbortSignal, stdout: Writable = process.stdout, waiting?: () => void): Promise<void> {
  signal.throwIfAborted();
  const project = await selectProject(directory, workspaceOverride);
  const existing = await app.workspace({ slug: project.workspace }).inspect({ signal });
  signal.throwIfAborted();
  if (!existing) { stdout.write(`No saved sessions. Workspace ${project.workspace} does not exist.\n`); return; }
  if (existing.slug !== project.workspace || !validWorkspaceId(existing.id)) throw new Error('Cantelop returned an invalid workspace identity.');
  const repository = await discoverRepository(project.localDirectory);
  const known = await localIdentities(project);
  const session = app.workspace({ id: existing.id }).session({ keepAliveSeconds: 0 });
  // Admission can take longer than the listing itself while another session finishes.
  const combined = AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_RETRY_MS + SESSION_LIST_TIMEOUT_MS)]);
  const sessions: Array<{ id: string; updatedAt: string }> = [];
  let after: string | undefined, unidentified = 0, unreadable = 0;
  let failed = false;
  try {
    do {
      combined.throwIfAborted();
      const command: SessionListCommand = { type: 'sessions-list', directoryName: project.directoryName,
        ...(repository ? { git: { binding: repository.binding, relativeDirectory: repository.relativeDirectory } } : {}), ...(after ? { after } : {}) };
      const reply = await retryAdmission(combined, () => session.request(command, { signal: combined, timeoutMs: 30_000 }), waiting);
      if (!reply?.ok || !reply.sessions) throw new Error(reply && !reply.ok ? reply.error : 'Session listing is unavailable. Build and deploy matching Juiced sources.');
      const page = validateSessionListPage(reply.sessions, after);
      for (const item of page.items) {
        const id = item.id ?? known.get(item.key);
        if (id) {
          if (sha256(id) !== item.key) throw new Error('The runtime returned an invalid session identity.');
          sessions.push({ id, updatedAt: item.updatedAt });
        } else unidentified++;
      }
      unreadable += page.unreadable;
      after = page.after;
    } while (after);
  } catch (error) {
    failed = true;
    if ((error as { code?: string }).code === 'session_not_found') {
      const command = `juiced${workspaceOverride ? ` --workspace ${project.workspace}` : ''} claude`;
      throw new Error(`Saved conversations could not be read because the workspace session is unavailable. Run ${command} sessions again. If this is a new workspace, finish Claude sign-in with ${command} login.`, { cause: error });
    }
    throw error;
  } finally {
    try { await session.stop(); }
    catch (error) {
      // A zero-keep-alive inspection may already have ended. Cleanup must not
      // hide a valid list or replace the original read failure with a stop error.
      if (!failed && (error as { code?: string }).code !== 'session_not_found') throw error;
    }
  }
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
