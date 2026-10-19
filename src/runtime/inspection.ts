import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionOutput } from '@cantelop/sdk/session';
import { captureInspection } from '../inspection-snapshot.js';
import { captureListing } from '../inspection-listing.js';
import { sha256 } from '../git.js';
import { INSPECTION_CHUNK_BYTES, MAX_INSPECTION_BYTES, InspectionIncomplete, validateInspectionCommand, type InspectionCommand, type InspectionEvent } from '../inspection-protocol.js';
import { readBinding } from './git.js';

/** Resolve existing state only. projectPaths/status would create or repair it. */
export async function inspectRemote(command: InspectionCommand, output: SessionOutput<InspectionEvent>, signal: AbortSignal, workspace = process.cwd()) {
  try {
    validateInspectionCommand(command);
    signal.throwIfAborted();
    const root = await realpath(workspace), metadata = join(root, '.juiced', command.directoryName), target = join(root, command.directoryName);
    for (const path of [join(root, '.juiced'), metadata, target, join(target, '.git')]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new InspectionIncomplete('The existing workspace checkout is unavailable or unsafe.');
    }
    const original = await lstat(target, { bigint: true });
    const check = async () => {
      const binding = await readBinding(metadata);
      if (binding?.binding !== command.binding) throw new InspectionIncomplete('This workspace has no matching Git binding. Select the workspace paired with this directory.');
      try {
        await readFile(join(metadata, 'journal.json'));
        throw new InspectionIncomplete('A Git publication is pending recovery. Inspection preserved it; retry after normal workspace recovery.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const current = await lstat(target, { bigint: true });
      if (current.dev !== original.dev || current.ino !== original.ino) throw new InspectionIncomplete('The remote checkout changed during inspection. Retry.');
    };
    await check();
    const snapshot = await (command.mode === 'listing' ? captureListing : captureInspection)(target, command.scope, command.includeIgnored, signal);
    await check();
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > MAX_INSPECTION_BYTES) throw new InspectionIncomplete('The inventory exceeds 64 MiB. Inspect a narrower path.');
    for (let offset = 0; offset < bytes.length; offset += INSPECTION_CHUNK_BYTES) {
      signal.throwIfAborted();
      await output.send({ type: 'inspection-chunk', id: command.id, offset, data: bytes.subarray(offset, offset + INSPECTION_CHUNK_BYTES).toString('base64') });
    }
    await output.send({ type: 'inspection-end', id: command.id, size: bytes.length, sha256: sha256(bytes) });
  } catch (error) {
    if (signal.aborted) throw error;
    const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'The remote Git checkout is not initialized. Inspection did not create it.'
      : error instanceof Error ? error.message : 'Workspace inspection failed';
    await output.send({ type: 'inspection-error', id: command.id, message });
  }
}
