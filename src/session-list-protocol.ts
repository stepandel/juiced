import { relativeProjectPath } from './git.js';
import { validProjectName } from './project-name.js';

export const SESSION_PAGE_SIZE = 100;
export const SESSION_LIST_TIMEOUT_MS = 60_000;
export type SessionListCommand = {
  type: 'sessions-list'; directoryName: string;
  git?: { binding: string; relativeDirectory: string }; after?: string;
};
export type SessionListItem = { key: string; id?: string; updatedAt: string };
export type SessionListPage = { items: SessionListItem[]; after?: string; unreadable: number };

export const validSessionId = (id: unknown): id is string => typeof id === 'string' && /^ses_[a-f0-9]{32}$/.test(id);
export const validSessionKey = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);

export function validateSessionListCommand(command: SessionListCommand) {
  if (!command || command.type !== 'sessions-list' || typeof command.directoryName !== 'string' || !validProjectName(command.directoryName) || command.after !== undefined && !validSessionKey(command.after) ||
      command.git !== undefined && (!command.git || !validSessionKey(command.git.binding) || typeof command.git.relativeDirectory !== 'string' || !relativeProjectPath(command.git.relativeDirectory))) {
    throw new Error('Invalid session listing command');
  }
}

export function validateSessionListPage(value: unknown, after?: string): SessionListPage {
  const page = value as SessionListPage | undefined;
  if (!page || !Array.isArray(page.items) || page.items.length > SESSION_PAGE_SIZE ||
      !Number.isSafeInteger(page.unreadable) || page.unreadable < 0 || page.unreadable > SESSION_PAGE_SIZE ||
      page.after !== undefined && (!validSessionKey(page.after) || after !== undefined && page.after <= after)) throw new Error('The runtime returned an invalid session list.');
  let previous = after ?? '';
  for (const item of page.items) {
    if (!item || !validSessionKey(item.key) || item.key <= previous ||
        item.id !== undefined && !validSessionId(item.id) || typeof item.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(item.updatedAt)) || page.after !== undefined && item.key > page.after) throw new Error('The runtime returned an invalid session list.');
    previous = item.key;
  }
  return page;
}
