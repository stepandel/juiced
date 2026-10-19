import type { SlashCommand } from '../agent-protocol.js';
import type { Editor } from './editor.js';

const local: SlashCommand[] = [
  { name: 'help', description: 'Show Juiced keyboard shortcuts', argumentHint: '' },
  { name: 'exit', description: 'Disconnect and stop Claude', argumentHint: '' },
  { name: 'quit', description: 'Disconnect and stop Claude', argumentHint: '' },
];

export function availableCommands(remote: SlashCommand[]): SlashCommand[] {
  const commands = new Map(remote.map(command => [command.name, command]));
  for (const command of local) commands.set(command.name, command);
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Only complete the command word; arguments and multiline drafts stay editable. */
export function matchingCommands(editor: Editor, commands: SlashCommand[]): SlashCommand[] {
  if (editor.cursor !== editor.text.length || !/^\/[^\s]*$/u.test(editor.text)) return [];
  const prefix = editor.text.slice(1).toLowerCase();
  return commands.filter(command => command.name.toLowerCase().startsWith(prefix));
}
