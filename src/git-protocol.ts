export const UPLOAD_CHUNK_BYTES = 192 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 32 * 1024;
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
export type TransferFile = 'bundle' | 'staged' | 'unstaged';
export type FileInfo = { name: TransferFile; size: number; sha256: string };
export type UploadManifest = {
  version: 1; head: string; branch: string | null; objectFormat: 'sha1' | 'sha256';
  author: { name: string; email: string }; files: FileInfo[];
};
export type GitStatus = { initialized: boolean; head?: string; sourceBranch?: string | null; dirty?: boolean };
export type ExportManifest = { head: string; sourceBranch: string | null; file: FileInfo };
export type StaleLease = { session: string; token: string };
export type GitCommand = { type: 'git'; directoryName: string; binding: string } & (
  | { action: 'status' }
  | { action: 'begin'; id: string; manifest: UploadManifest }
  | { action: 'chunk'; id: string; file: TransferFile; offset: number; data: string }
  | { action: 'apply'; id: string; initializeOnly: boolean }
  | { action: 'export'; id: string; known: string }
  | { action: 'download'; id: string; offset: number }
  | { action: 'cleanup'; id: string }
  | { action: 'reap'; leases: StaleLease[] }
);
export type GitResult = { status?: GitStatus; offset?: number; manifest?: ExportManifest };
export type GitEvent =
  | { type: 'git-chunk'; id: string; offset: number; data: string }
  | { type: 'git-end'; id: string; size: number; sha256: string }
  | { type: 'git-error'; id: string; message: string };

export function validOid(value: unknown): value is string { return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
export function validTransferId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value); }
