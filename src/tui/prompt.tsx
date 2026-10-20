import React, { useReducer, useRef } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { SlashCommand } from '../agent-protocol.js';
import { cursorParts, edit, type Editor } from './editor.js';
import { plain } from './conversation.js';
import { matchingCommands } from './commands.js';
import { Clipped, Rule } from './chrome.js';

type Draft = { current: Editor };
export function useDraft(): [Draft, (next: Editor) => void] {
  const current = useRef<Editor>({ text: '', cursor: 0 });
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  // Multiple key events can arrive before React commits a render. Keep their
  // edits synchronous so rapid typing never reads an earlier cursor or draft.
  return [current, next => { current.current = next; refresh(); }];
}

type PromptProps = {
  editor: Draft; onEdit(value: Editor): void; onSubmit(value: string): void;
  onEscape?(): void; onHelp?(): void; onKey?(): void; onCycleMode?(): void;
  commands?: SlashCommand[]; history?: string[]; menuRows?: number; disabled?: boolean; placeholder?: string;
};
export function Prompt({ editor, onEdit, onSubmit, onEscape, onHelp, onKey, onCycleMode, commands, history = [], menuRows = 5, disabled = false, placeholder = 'Ask Claude to work in your remote workspace…' }: PromptProps) {
  const menu = useRef({ query: '', index: 0, dismissed: false });
  // -1 is the unsent draft; 0 is the most recent prompt.
  const recall = useRef({ index: -1, draft: '' });
  const [, refreshMenu] = useReducer((value: number) => value + 1, 0);
  // Read the current draft for every key, including rapid arrow + Enter input.
  const suggestions = () => {
    const matches = disabled || !commands ? [] : matchingCommands(editor.current, commands);
    const query = matches.length ? editor.current.text : '';
    if (menu.current.query !== query) menu.current = { query, index: 0, dismissed: false };
    menu.current.index = Math.min(menu.current.index, Math.max(0, matches.length - 1));
    return menu.current.dismissed ? [] : matches;
  };
  const change = (value: Editor) => { recall.current.index = -1; onEdit(value); };
  usePaste(text => change(edit(editor.current, text, {})), { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && ['c', 'd'].includes(input)) return;
    if (input === '?' && !editor.current.text && onHelp) { onHelp(); return; }
    onKey?.();
    const matches = suggestions();
    if (key.escape) {
      if (matches.length) { menu.current.dismissed = true; refreshMenu(); }
      else onEscape?.();
      return;
    }
    if (matches.length && (key.upArrow || key.downArrow)) {
      menu.current.index = (menu.current.index + (key.upArrow ? -1 : 1) + matches.length) % matches.length;
      refreshMenu(); return;
    }
    const { text, cursor } = editor.current;
    if (history.length && (key.upArrow && !text.slice(0, cursor).includes('\n') || key.downArrow && !text.slice(cursor).includes('\n') && recall.current.index >= 0)) {
      const state = recall.current;
      if (state.index === -1) state.draft = text;
      state.index = Math.max(-1, Math.min(history.length - 1, state.index + (key.upArrow ? 1 : -1)));
      const value = state.index === -1 ? state.draft : history[history.length - 1 - state.index]!;
      onEdit({ text: value, cursor: value.length }); return;
    }
    if (key.tab && key.shift && !matches.length) { onCycleMode?.(); return; }
    const selected = matches[menu.current.index];
    if (selected && key.tab) {
      const value = `/${selected.name} `;
      change({ text: value, cursor: value.length }); return;
    }
    if (key.return && !key.meta && !key.shift) {
      if (text.endsWith('\\')) { change({ text: text.slice(0, -1) + '\n', cursor: text.length }); return; }
      recall.current.index = -1;
      onSubmit(selected ? `/${selected.name}` : text); return;
    }
    change(edit(editor.current, input, key));
  }, { isActive: !disabled });
  const [before, cursor, after] = cursorParts(editor.current);
  const matches = suggestions();
  const start = Math.max(0, menu.current.index - menuRows + 1);
  const label = (command: SlashCommand) => `/${command.name}${command.argumentHint ? ` ${plain(command.argumentHint).replace(/\s+/g, ' ')}` : ''}`;
  const column = Math.min(32, Math.max(0, ...matches.map(command => label(command).length)) + 2);
  return <Box flexDirection="column">
    {matches.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {matches.slice(start, start + menuRows).map((command, i) => {
        const selected = start + i === menu.current.index;
        return <Box key={command.name} height={1} paddingLeft={2}>
          <Box width={2} flexShrink={0}><Text color="green">{selected ? '❯' : ' '}</Text></Box>
          <Box width={column} flexShrink={0}><Text wrap="truncate-end" {...(selected ? { color: 'green' } : {})}>{label(command)}</Text></Box>
          <Box flexGrow={1}><Text wrap="truncate-end" {...(selected ? { color: 'green' } : { dimColor: true })}>{plain(command.description).replace(/\s+/g, ' ')}</Text></Box>
        </Box>;
      })}
    </Box>}
    <Rule bottom color={disabled ? 'gray' : 'green'}>
      <Box>
        <Box width={2} flexShrink={0}><Text color={disabled ? 'gray' : 'green'}>❯</Text></Box>
        <Box flexGrow={1}><Clipped tail><Text>{editor.current.text
          ? <>{before}<Text inverse={!disabled}>{cursor}</Text>{after}</>
          : <><Text inverse={!disabled} dimColor>{placeholder.slice(0, 1)}</Text><Text dimColor>{placeholder.slice(1)}</Text></>}</Text></Clipped></Box>
      </Box>
    </Rule>
  </Box>;
}
