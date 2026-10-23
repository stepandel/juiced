import type { ExportManifest } from './git-protocol.js';
import { MAX_LOCAL_RESULT_BYTES, validateLocalFileListing, type LocalFileListing, type LocalFilesCommand, type LocalFilesRequest } from './local-files-protocol.js';

export type PublishKind = 'commits' | 'snapshot';
export type Publication = {
  id: string; kind: PublishKind; summary: string; expiresAt: number;
  manifest: ExportManifest; paths: string[]; fileCount: number;
};
export type UploadRequest = {
  id: string; kind: 'upload'; summary: string; expiresAt: number;
  head: string; sourceBranch: string | null; includeUncommitted: boolean;
};
export type LocalTransfer = Publication | UploadRequest | LocalFilesRequest;
export type PublishResult = {
  status: 'applied' | 'already-applied' | 'declined' | 'conflict' | 'failed';
  message: string;
  uploadId?: string;
  listing?: LocalFileListing;
};
export type PublishCommand =
  | { type: 'publish-status'; id: string }
  | { type: 'publish-claim'; id: string; client: string }
  | { type: 'publish-result'; id: string; client: string; result: PublishResult }
  | LocalFilesCommand;

export const PUBLISH_TIMEOUT_MS = 5 * 60 * 1000;
export const publishSucceeded = (result: PublishResult) => result.status === 'applied' || result.status === 'already-applied';

export function validatePublishResult(result: PublishResult): void {
  if (!result || !['applied', 'already-applied', 'declined', 'conflict', 'failed'].includes(result.status) || typeof result.message !== 'string' || result.message.length > 8000 ||
      result.uploadId !== undefined && !/^[a-f0-9-]{36}$/.test(result.uploadId) || Buffer.byteLength(JSON.stringify(result)) > MAX_LOCAL_RESULT_BYTES)
    throw new Error('Invalid local publication result');
  if (result.listing !== undefined) validateLocalFileListing(result.listing);
}
