/** Bounded, project-relative file access over the attached Juiced client. */
export const LOCAL_FILE_CHUNK_BYTES = 48 * 1024;
export const MAX_LOCAL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LOCAL_FILES_BYTES = 64 * 1024 * 1024;
export const MAX_LOCAL_FILES = 256;
export const LOCAL_LIST_PAGE = 100;
export const MAX_LOCAL_RESULT_BYTES = 128 * 1024;

export type LocalFilesRequest = {
  id: string; kind: 'files'; summary: string; expiresAt: number;
} & ({ action: 'list'; path: string; includeHidden: boolean; offset: number }
  | { action: 'pull'; paths: string[]; destination: string });
export type LocalFileEntry = { path: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number };
export type LocalFileListing = { path: string; entries: LocalFileEntry[]; nextOffset?: number };
export type LocalFileInfo = { path: string; size: number; sha256: string; executable: boolean };
export type LocalFilesPayload = { type: 'publish-files'; id: string } & (
  { action: 'begin'; files: LocalFileInfo[] }
  | { action: 'chunk'; index: number; offset: number; data: string });
export type LocalFilesCommand = LocalFilesPayload & { client: string };

export function localFilePath(value: unknown, root = false): value is string {
  return typeof value === 'string' && (root && value === '.' || value.length > 0 && value.length <= 1024 &&
    !/[\\\x00-\x1f\x7f]/u.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
}

export function validateLocalFilesRequest(request: LocalFilesRequest): void {
  if (request.action === 'list') {
    if (!localFilePath(request.path, true) || typeof request.includeHidden !== 'boolean' || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 4096)
      throw new Error('Invalid local listing request. Use a project-relative path.');
  } else if (request.action !== 'pull' || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > 64 ||
      request.paths.some(path => !localFilePath(path)) || !localFilePath(request.destination, true) || Buffer.byteLength(JSON.stringify(request.paths)) > 8000) {
    throw new Error('Invalid local file request. Select project-relative files or directories; the project root and .git cannot be pulled.');
  }
}

export function validateLocalFileManifest(files: LocalFileInfo[], request: Extract<LocalFilesRequest, { action: 'pull' }>): void {
  if (!Array.isArray(files) || !files.length || files.length > MAX_LOCAL_FILES) throw new Error('Invalid local file manifest.');
  let bytes = 0;
  const names = new Set<string>();
  for (const file of files) {
    if (!file || !localFilePath(file.path) || !localFilePath(request.destination === '.' ? file.path : `${request.destination}/${file.path}`) ||
        !request.paths.some(path => file.path === path || file.path.startsWith(path + '/')) || names.has(file.path) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_LOCAL_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== 'boolean')
      throw new Error('Invalid or out-of-scope local file manifest.');
    names.add(file.path); bytes += file.size;
  }
  if (bytes > MAX_LOCAL_FILES_BYTES || Buffer.byteLength(JSON.stringify(files)) > MAX_LOCAL_RESULT_BYTES) throw new Error('The local file transfer is too large.');
  for (const name of names) for (const other of names) if (name.startsWith(other + '/')) throw new Error('Conflicting local file paths.');
}

export function validateLocalFileListing(listing: LocalFileListing): void {
  if (!listing || !localFilePath(listing.path, true) || !Array.isArray(listing.entries) || listing.entries.length > LOCAL_LIST_PAGE ||
      listing.nextOffset !== undefined && (!Number.isSafeInteger(listing.nextOffset) || listing.nextOffset < 0 || listing.nextOffset > 4096) ||
      listing.entries.some(entry => !entry || !localFilePath(entry.path) || !['file', 'directory', 'symlink', 'other'].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0))
    throw new Error('Invalid local file listing.');
}
