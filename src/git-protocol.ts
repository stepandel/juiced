import type { GitRemoteConfiguration } from './git-remotes.js';

export const UPLOAD_CHUNK_BYTES = 192 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 32 * 1024;
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
export type TransferFile = 'bundle' | 'staged' | 'unstaged' | 'snapshot';
export type FileInfo = { name: TransferFile; size: number; sha256: string };
export type UploadManifest = {
  version: 1; head: string; branch: string | null; objectFormat: 'sha1' | 'sha256';
  author: { name: string; email: string }; files: FileInfo[];
  /** A patch-only upload requires this exact commit to exist in the receiver. */
  base?: string;
};
/** `uploadParts` advertises runtime support for part chunks, `finish` and patch-only manifests. */
export type GitStatus = { initialized: boolean; head?: string; sourceBranch?: string | null; dirty?: boolean; uploadParts?: boolean };
export type SnapshotManifest = { baseHead: string; baseTree: string; tree: string; file: FileInfo };
export type ExportManifest = { head: string; sourceBranch: string | null; file: FileInfo; snapshot?: SnapshotManifest };
export type StaleLease = { session: string; token: string };
export type GitCommand = { type: 'git'; directoryName: string; binding: string } & (
  | { action: 'status' }
  | { action: 'configure'; configuration: GitRemoteConfiguration }
  | { action: 'begin'; id: string; manifest: UploadManifest }
  | { action: 'chunk'; id: string; file: TransferFile; offset: number; data: string; part?: boolean }
  | { action: 'finish'; id: string }
  | { action: 'apply'; id: string; initializeOnly: boolean }
  | { action: 'export'; id: string; known: string; head?: string; snapshot?: boolean }
  | { action: 'download'; id: string; offset: number; file?: 'bundle' | 'snapshot' }
  | { action: 'cleanup'; id: string }
  | { action: 'reap'; leases: StaleLease[] }
);
export type GitResult = { status?: GitStatus; offset?: number; manifest?: ExportManifest };
export type GitEvent =
  | { type: 'git-chunk'; id: string; offset: number; data: string; file?: 'bundle' | 'snapshot' }
  | { type: 'git-end'; id: string; size: number; sha256: string; file?: 'bundle' | 'snapshot' }
  | { type: 'git-error'; id: string; message: string };

export function validOid(value: unknown): value is string { return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
export function validTransferId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }

export function validateExportManifest(value: ExportManifest): void {
  const file = (info: FileInfo, name: string, limit: number) => info && info.name === name && Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= limit && typeof info.sha256 === 'string' && /^[a-f0-9]{64}$/.test(info.sha256);
  if (!value || !validOid(value.head) || value.sourceBranch !== null && typeof value.sourceBranch !== 'string' || !file(value.file, 'bundle', MAX_TRANSFER_BYTES) ||
      value.snapshot && (!validOid(value.snapshot.baseHead) || !validOid(value.snapshot.baseTree) || !validOid(value.snapshot.tree) || !file(value.snapshot.file, 'snapshot', 64 * 1024 * 1024)) ||
      value.file.size + (value.snapshot?.file.size ?? 0) > MAX_TRANSFER_BYTES) throw new Error('Invalid Git export manifest');
}
