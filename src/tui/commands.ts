import type { SlashCommand } from '../agent-protocol.js';
import type { Editor } from './editor.js';
import { menuCommands } from './command-menus.js';

const local: SlashCommand[] = [
  { name: 'help', description: 'Show Juiced keyboard shortcuts', argumentHint: '' },
  { name: 'model', description: 'Choose the model for this session', argumentHint: '[name]' },
  { name: 'exit', description: 'Disconnect and stop Claude', argumentHint: '' },
  { name: 'detach', description: 'Disconnect while Claude keeps working; reattach with juiced claude in this tab', argumentHint: '' },
  { name: 'quit', description: 'Disconnect and stop Claude', argumentHint: '' },
];

export function availableCommands(remote: SlashCommand[]): SlashCommand[] {
  const commands = new Map(remote.map(command => [command.name, command]));
  for (const command of [...menuCommands, ...local]) commands.set(command.name, command);
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Only complete the command word; arguments and multiline drafts stay editable. */
export function matchingCommands(editor: Editor, commands: SlashCommand[]): SlashCommand[] {
  if (editor.cursor !== editor.text.length || !/^\/[^\s]*$/u.test(editor.text)) return [];
  const prefix = editor.text.slice(1).toLowerCase();
  return commands.filter(command => command.name.toLowerCase().startsWith(prefix));
}
