import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import { validProjectName } from './project-name.js';

export interface Project {localDirectory:string;directoryName:string;remoteDirectory:string;workspace:string;scope?:string}
export async function selectProject(directory: string, workspace?: string):Promise<Project> {
  const localDirectory = await realpath(directory);
  const directoryName = basename(localDirectory);
  if (!validProjectName(directoryName)) throw new Error('This directory name cannot be used as a remote project folder. Use a visible project directory with a portable name.');
  const label = directoryName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 46).replace(/-+$/g, '') || 'project';
  const hash = createHash('sha256').update(localDirectory).digest('hex').slice(0, 16);
  return { localDirectory, directoryName, remoteDirectory: `/workspace/${directoryName}`, workspace: workspace ?? `${label}-${hash}` };
}
