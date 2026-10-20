import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { duration } from './conversation.js';

export function Clipped({ children, tail = false }: { children: React.ReactNode; tail?: boolean }) {
  return <Box flexDirection="column" overflow="hidden" justifyContent={tail ? 'flex-end' : 'flex-start'}>
    <Box flexDirection="column" flexShrink={0}>{children}</Box>
  </Box>;
}

/** A horizontal rule above (and optionally below) its content, like Claude Code's prompt and dialogs. */
export function Rule({ color, bottom = false, indent = 0, children }: { color: string; bottom?: boolean; indent?: number; children: React.ReactNode }) {
  return <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={bottom} borderColor={color} paddingLeft={indent} overflow="hidden">{children}</Box>;
}

const glyphs = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
export const spinnerVerbs = ['Thinking', 'Juicing', 'Squeezing', 'Pondering', 'Brewing', 'Cogitating', 'Churning', 'Crunching', 'Percolating', 'Simmering', 'Mulling', 'Blending', 'Zesting', 'Pulping', 'Noodling'];
const compact = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/u, '')}k` : String(count);

export function Spinner({ label, since, tokens }: { label: string; since?: number | undefined; tokens?: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => { const timer = setInterval(() => setFrame(value => value + 1), 120); return () => clearInterval(timer); }, []);
  const detail = since === undefined ? [] : [duration(Date.now() - since), ...(tokens ? [`↓ ${compact(tokens)} tokens`] : [])];
  return <Text wrap="truncate-end"><Text color="cyan">{glyphs[frame % glyphs.length]} {label}…</Text><Text dimColor>{detail.length ? ` (${detail.join(' · ')})` : ''}</Text></Text>;
}

export const modes: Record<string, [string, string]> = {
  default: ['⏸', 'manual mode on'], acceptEdits: ['⏵⏵', 'accept edits on'], plan: ['⏸', 'plan mode on'],
  auto: ['⏵⏵', 'auto mode on'], dontAsk: ['⏵⏵', 'don’t ask mode on'], bypassPermissions: ['⏵⏵', 'bypass permissions on'],
};
/** Claude Code's Shift+Tab order; sessions launched in bypass mode can also cycle back to it. */
export const modeCycle = ['default', 'acceptEdits', 'plan', 'auto'];
/** Auto mode depends on the account, which Claude reports only by refusing it. */
export const optional = new Set(['auto']);
export type Pending = 'ctrl-c' | 'ctrl-d' | 'esc';

export function Footer({ mode, pending, busy, empty, model }: { mode: string; pending?: Pending | undefined; busy: boolean; empty: boolean; model: string }) {
  const [symbol, label] = modes[mode] ?? ['⏵⏵', `${mode} mode on`];
  return <Box flexShrink={0} height={1} paddingX={2} justifyContent="space-between">
    <Box flexShrink={1}>{pending
      ? <Text dimColor wrap="truncate-end">{pending === 'esc' ? 'Esc again to clear' : `Press ${pending === 'ctrl-c' ? 'Ctrl-C' : 'Ctrl-D'} again to exit`}</Text>
      : <Text wrap="truncate-end">
        <Text {...(mode === 'default' ? { dimColor: true } : { color: mode === 'bypassPermissions' ? 'yellow' : 'green' })}>{symbol} {label}</Text>
        <Text dimColor>{mode === 'default' ? '' : ' (shift+tab to cycle)'}{busy ? ' · esc to interrupt' : empty && mode === 'default' ? ' · ? for shortcuts' : ''}</Text>
      </Text>}</Box>
    {model && <Box flexShrink={0} marginLeft={2}><Text dimColor>{model}</Text></Box>}
  </Box>;
}

const shortcuts = [
  ['/ for commands', 'shift + tab to cycle modes', 'ctrl + c to clear or exit'],
  ['esc to interrupt', 'double tap esc to clear input', 'ctrl + u/k/w to delete'],
  ['↑/↓ for prompt history', 'backslash (\\) + return (⏎) for newline', '/detach to leave Claude running'],
  ['ctrl + o for detailed transcript', '', ''],
];
export function Shortcuts() {
  return <Box flexShrink={0} paddingX={2}>{[0, 1, 2].map(column => <Box key={column} flexDirection="column" width="33%" paddingRight={1}>
    {shortcuts.map(row => <Text key={row[column]} dimColor>{row[column]}</Text>)}
  </Box>)}</Box>;
}
