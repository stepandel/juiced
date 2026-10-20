import type { ExportManifest } from './git-protocol.js';

export type PublishKind = 'commits' | 'snapshot';
export type Publication = {
  id: string; kind: PublishKind; summary: string; expiresAt: number;
  manifest: ExportManifest; paths: string[]; fileCount: number;
};
export type PublishResult = {
  status: 'applied' | 'already-applied' | 'declined' | 'conflict' | 'failed';
  message: string;
};
export type PublishCommand =
  | { type: 'publish-status'; id: string }
  | { type: 'publish-claim'; id: string; client: string }
  | { type: 'publish-result'; id: string; client: string; result: PublishResult };

export const PUBLISH_TIMEOUT_MS = 5 * 60 * 1000;
export const publishSucceeded = (result: PublishResult) => result.status === 'applied' || result.status === 'already-applied';

export function validatePublishResult(result: PublishResult): void {
  if (!result || !['applied', 'already-applied', 'declined', 'conflict', 'failed'].includes(result.status) || typeof result.message !== 'string' || result.message.length > 8000)
    throw new Error('Invalid local publication result');
}
