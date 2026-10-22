import { posix } from 'node:path';
import { validOid, validTransferId } from './git-protocol.js';
import { relativeProjectPath } from './git.js';
import { validProjectName } from './project-name.js';
import { isRecord as record } from './agent-protocol.js';

export const MAX_INSPECTION_BYTES = 64 * 1024 * 1024;
export const INSPECTION_CHUNK_BYTES = 32 * 1024;
// Leave room below the SDK's 64 KiB serialized request-reply limit.
export const MAX_INSPECTION_REPLY_BYTES = 60 * 1024;
export const INSPECTION_TIMEOUT_MS = 240_000;
export type TreeEntry = { name: string; mode: '040000' | '100644' | '100755' | '120000' | '160000'; oid: string };
export type ListingEntry = Pick<TreeEntry, 'name' | 'mode'>;
export type InspectionListing = {
  version: 1; scope: string; kind: 'directory' | 'file' | 'missing' | 'ignored';
  entry?: ListingEntry; entries: ListingEntry[];
};
export type InspectionSnapshot = {
  version: 1; scope: string; kind: 'directory' | 'file' | 'missing' | 'ignored';
  entry?: TreeEntry; entries: TreeEntry[]; ignored: string[];
  submodules?: string[];
  head: string; branch: string | null; objectFormat: 'sha1' | 'sha256';
  startedAt: string; finishedAt: string;
};
export type InspectionCommand = {
  type: 'inspect'; id: string; directoryName: string; binding: string; scope: string; includeIgnored: boolean;
  mode?: 'listing';
  inline?: boolean;
};
export type InspectionEvent =
  | { type: 'inspection-chunk'; id: string; offset: number; data: string }
  | { type: 'inspection-end'; id: string; size: number; sha256: string }
  | { type: 'inspection-error'; id: string; message: string };

export class InspectionIncomplete extends Error { readonly code = 'inspection_incomplete'; }

export function submoduleContents(path: string): never {
  throw new InspectionIncomplete(`Cannot inspect contents of nested Git repository ${JSON.stringify(path)}. Inspect its parent directory to compare the remaining files.`);
}

export function inspectionScope(path = '.') {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) throw new Error('Inspection path must stay within the current directory.');
  const normalized = posix.normalize(path).replace(/\/$/, '');
  const scope = normalized === '.' ? '' : normalized;
  if (!relativeProjectPath(scope)) throw new Error('Invalid inspection path; Git metadata cannot be inspected.');
  return scope;
}

export function validateInspectionCommand(command: InspectionCommand) {
  if (!command || command.type !== 'inspect' || !validTransferId(command.id) || !validProjectName(command.directoryName) ||
      !/^[a-f0-9]{64}$/.test(command.binding) || !relativeProjectPath(command.scope) || typeof command.includeIgnored !== 'boolean' ||
      (command.mode !== undefined && command.mode !== 'listing') ||
      (command.inline !== undefined && typeof command.inline !== 'boolean')) throw new Error('Invalid workspace inspection command');
}

const name = (value: unknown): value is string => typeof value === 'string' && !!value && !['.', '..', '.git'].includes(value) && !value.includes('/') && !value.includes('\0');
function entry(value: unknown): value is TreeEntry {
  return record(value) && name(value.name) && ['040000', '100644', '100755', '120000', '160000'].includes(String(value.mode)) && validOid(value.oid);
}
export function validateInspectionListing(value: unknown, scope: string): InspectionListing {
  const listed = (item: unknown): item is ListingEntry => record(item) && name(item.name) && ['040000', '100644', '100755', '120000', '160000'].includes(String(item.mode));
  if (!record(value) || value.version !== 1 || value.scope !== scope || !['directory', 'file', 'missing', 'ignored'].includes(String(value.kind)) ||
      !Array.isArray(value.entries) || !value.entries.every(listed) || new Set(value.entries.map(item => item.name)).size !== value.entries.length ||
      (value.kind !== 'directory' && value.entries.length !== 0) ||
      (value.kind === 'directory' ? !listed(value.entry) || value.entry.mode !== '040000' :
        value.kind === 'file' ? !listed(value.entry) || value.entry.mode === '040000' : value.entry !== undefined)) throw new InspectionIncomplete('The runtime returned an invalid workspace listing.');
  return value as InspectionListing;
}
export function validateInspectionSnapshot(value: unknown, scope: string): InspectionSnapshot {
  if (!record(value) || value.version !== 1 || value.scope !== scope || !['directory', 'file', 'missing', 'ignored'].includes(String(value.kind)) ||
      !Array.isArray(value.entries) || !value.entries.every(entry) || new Set(value.entries.map(item => item.name)).size !== value.entries.length ||
      !Array.isArray(value.ignored) || !value.ignored.every(name) || !validOid(value.head) ||
      (value.submodules !== undefined && (!Array.isArray(value.submodules) || !value.submodules.every(name) || new Set(value.submodules).size !== value.submodules.length)) ||
      !(value.branch === null || typeof value.branch === 'string') || !['sha1', 'sha256'].includes(String(value.objectFormat)) ||
      typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt)) ||
      (value.entry !== undefined && !entry(value.entry)) || (['file', 'directory'].includes(String(value.kind)) && !entry(value.entry)) ||
      (value.kind !== 'directory' && value.entries.length !== 0)) throw new InspectionIncomplete('The runtime returned an invalid workspace inspection.');
  if ((value.kind === 'directory' && (value.entry as TreeEntry).mode !== '040000') ||
      (value.kind === 'file' && (value.entry as TreeEntry).mode === '040000') ||
      (['missing', 'ignored'].includes(String(value.kind)) && value.entry !== undefined)) throw new InspectionIncomplete('The runtime returned an inconsistent entry type.');
  const length = value.objectFormat === 'sha1' ? 40 : 64;
  if (value.head.length !== length || value.entries.some(item => item.oid.length !== length) || value.entry && (value.entry as TreeEntry).oid.length !== length) throw new InspectionIncomplete('The runtime returned inconsistent Git object formats.');
  return value as InspectionSnapshot;
}
