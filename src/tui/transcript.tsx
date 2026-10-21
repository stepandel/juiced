import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Entry } from './conversation.js';
import { Markdown } from './markdown.js';

const mascot = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '];
/** The site's --green, so the intro ends on the header's exact color. */
const juice = '#4eba65';
const claude = [0xd9, 0x77, 0x57], green = [0x4e, 0xba, 0x65];
const blend = (t: number) => `#${claude.map((from, i) => Math.round(from + (green[i]! - from) * t).toString(16).padStart(2, '0')).join('')}`;

export function Header({ workspace, session }: { workspace: string; session: string }) {
  return <Box flexDirection="column" marginBottom={1}>
    <Text><Text color={juice}>{mascot[0]}</Text>  <Text bold>Juiced</Text> <Text dimColor>· Claude Code on Cantelop</Text></Text>
    <Text><Text color={juice}>{mascot[1]}</Text>  <Text dimColor>workspace {workspace} · session {session}</Text></Text>
    <Text><Text color={juice}>{mascot[2]}</Text>  <Text dimColor>reattach with juiced claude in this tab</Text></Text>
  </Box>;
}

/** Before the header prints, the Claude mascot drinks a glass of juice through a straw and turns green. */
export function Intro({ done }: { done(): void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 70); return () => clearInterval(timer); }, []);
  useEffect(() => { if (tick === 26) done(); }, [tick]);
  const sip = Math.min(1, Math.max(0, (tick - 4) / 14));
  // Four half rows of juice across the glass's two rows.
  const level = Math.ceil(4 * (1 - sip));
  const color = blend(sip * sip * (3 - 2 * sip));
  const full = (row: number) => level >= 4 - 2 * row;
  const cell = (row: number) => <Text color={juice}>{full(row) ? '█' : level === 3 - 2 * row ? '▄' : ' '}</Text>;
  const glass = (row: number) => <> <Text dimColor>▕</Text>{cell(row)}<Text color="white" {...(full(row) ? { backgroundColor: juice } : {})}>│</Text>{cell(row)}<Text dimColor>▏</Text></>;
  const sparkle = (on: boolean) => <Text color={juice}>{on ? (tick % 2 ? '✦' : '✧') : ' '}</Text>;
  return <Box flexDirection="column" marginBottom={1}>{tick < 20
    ? <>
      <Text wrap="truncate-end"><Text color={color}>{mascot[0]!.trimEnd()}</Text><Text color="white">────╮</Text></Text>
      <Text wrap="truncate-end"><Text color={color}>{mascot[1]}</Text>{glass(0)}</Text>
      <Text wrap="truncate-end"><Text color={color}>{mascot[2]}</Text>{glass(1)}</Text>
    </>
    : mascot.map((row, i) => <Text key={i} wrap="truncate-end"><Text color={juice}>{row}</Text> {sparkle(i !== 1)} {sparkle(i === 1)}</Text>)}
  </Box>;
}

// Claude Code folds finished reads, searches and shell commands into one line
// per run of calls; Ctrl+O shows their full output.
const folded: Record<string, [string, string, string]> = {
  Read: ['read', 'file', 'files'], Grep: ['searched for', 'pattern', 'patterns'], Glob: ['searched for', 'pattern', 'patterns'], LS: ['listed', 'directory', 'directories'],
  Bash: ['ran', 'shell command', 'shell commands'],
};
type Row = Entry | { id: string; kind: 'folded'; entries: Entry[] };
const foldable = (entry: Entry) => entry.kind === 'tool' && entry.status === 'done' && Object.hasOwn(folded, entry.tool ?? '');

export function rows(entries: Entry[]): Row[] {
  const result: Row[] = [];
  for (const entry of entries) {
    const previous = result.at(-1);
    if (!foldable(entry)) result.push(entry);
    else if (previous?.kind === 'folded') previous.entries.push(entry);
    else result.push({ id: `folded-${entry.id}`, kind: 'folded', entries: [entry] });
  }
  return result;
}

/** For example "Read 2 files, searched for 1 pattern". */
export function foldedSummary(entries: Entry[]): { verb: string; count: number; noun: string }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(folded[entry.tool!]![0], (counts.get(folded[entry.tool!]![0]) ?? 0) + 1);
  return [...counts].map(([verb, count], i) => {
    const [, one, many] = Object.values(folded).find(word => word[0] === verb)!;
    return { verb: i ? verb : verb[0]!.toUpperCase() + verb.slice(1), count, noun: count === 1 ? one : many };
  });
}

function Folded({ entries }: { entries: Entry[] }) {
  return <Box paddingLeft={2}><Text dimColor>{foldedSummary(entries).map((part, i) => <React.Fragment key={i}>{i ? ', ' : ''}{part.verb} <Text bold>{part.count}</Text> {part.noun}</React.Fragment>)}</Text></Box>;
}

function Result({ text, color }: { text: string; color?: string }) {
  return <Box><Box width={5} flexShrink={0}><Text dimColor>  ⎿ </Text></Box><Box flexGrow={1}><Text dimColor={!color} {...(color ? { color } : {})}>{text}</Text></Box></Box>;
}

function Bullet({ color, dim = false, children }: { color?: string | undefined; dim?: boolean; children: React.ReactNode }) {
  return <Box><Box width={2} flexShrink={0}><Text dimColor={dim} {...(color ? { color } : {})}>●</Text></Box><Box flexGrow={1} flexDirection="column">{children}</Box></Box>;
}

function Tool({ entry }: { entry: Entry }) {
  const open = entry.text.indexOf('(');
  const name = open > 0 && entry.text.endsWith(')') ? entry.text.slice(0, open) : entry.text;
  const args = name === entry.text ? '' : entry.text.slice(open);
  return <Box flexDirection="column">
    <Bullet dim={entry.status === 'running'} color={entry.status === 'failed' ? 'yellow' : entry.status === 'done' ? 'green' : undefined}><Text><Text bold>{name}</Text>{args}</Text></Bullet>
    {entry.status === 'running' ? <Result text="Running…" /> : entry.detail ? <Result text={entry.detail} {...(entry.status === 'failed' ? { color: 'yellow' } : {})} /> : null}
  </Box>;
}

function EntryRow({ row, tail }: { row: Row; tail?: number | undefined }) {
  if (row.kind === 'folded') return <Folded entries={row.entries} />;
  if (row.kind === 'user') return <Box><Box width={2} flexShrink={0}><Text color="green">❯</Text></Box><Box flexGrow={1}><Text backgroundColor="blackBright">{row.text}</Text></Box></Box>;
  if (row.kind === 'tool') return <Tool entry={row} />;
  if (row.kind === 'summary') return <Text dimColor>✻ {row.text}</Text>;
  if (row.kind === 'notice') {
    if (row.status === 'done') return <Bullet color="green"><Text>{row.text}</Text></Bullet>;
    return <Result color="yellow" text={row.id === 'interrupted' ? `${row.text} · What should Claude do instead?` : row.text} />;
  }
  return <Bullet><Markdown text={row.text} tail={tail} /></Bullet>;
}

// Unchanged entries keep their identity across frames, so only the entry that
// changed renders again. Folded runs are rebuilt each time from the same entries.
const sameRow = (a: Row, b: Row) => a === b || a.kind === 'folded' && b.kind === 'folded' && a.entries.length === b.entries.length && a.entries.every((entry, i) => entry === b.entries[i]);
const MemoRow = React.memo(EntryRow, (a, b) => a.tail === b.tail && sameRow(a.row, b.row));

/** `tail` limits each text entry to its last rows, for a view clipped to its bottom rows. */
export function Entries({ entries, tail }: { entries: Entry[]; tail?: number }) {
  return <Box flexDirection="column">{rows(entries).map(row => <Box key={row.id} marginBottom={1} flexDirection="column"><MemoRow row={row} tail={tail} /></Box>)}</Box>;
}
