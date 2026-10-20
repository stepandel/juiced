import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import type { Entry } from './conversation.js';
import { markdownRows, StyledRow, type Row, type Span } from './markdown.js';
import { Rule } from './chrome.js';

/** Rows of the Ctrl+O transcript: every entry, with complete tool output. */
export function transcriptLines(entries: Entry[]): Row[] {
  return entries.flatMap(entryLines);
}

const lead = (rows: Row[], first: Span, rest = ' '.repeat(first.text.length)) => rows.map((row, i) => [i ? { text: rest } : first, ...row]);
const plainRows = (text: string, style: Omit<Span, 'text'> = {}) => text.split('\n').map(line => [{ ...style, text: line }]);
const result = (text: string, style: Omit<Span, 'text'> = {}) => lead(plainRows(text, style), { text: '  ⎿  ', dim: true }, '     ');
function entryLines(entry: Entry): Row[] {
  const open = entry.text.indexOf('(');
  const body = entry.kind === 'user' ? lead(plainRows(entry.text), { text: '❯ ', color: 'green' })
    : entry.kind === 'text' ? lead(markdownRows(entry.text), { text: '● ' })
    : entry.kind === 'tool' ? [
      [
        { text: '● ', ...(entry.status === 'failed' ? { color: 'yellow' } : entry.status === 'done' ? { color: 'green' } : { dim: true }) },
        { text: open > 0 ? entry.text.slice(0, open) : entry.text, bold: true },
        { text: open > 0 ? entry.text.slice(open) : '' },
      ],
      ...result(entry.output ?? entry.detail ?? (entry.status === 'running' ? 'Running…' : '(No content)'), entry.status === 'failed' ? { color: 'yellow' } : {}),
    ]
    : entry.kind === 'summary' ? [[{ text: `✻ ${entry.text}`, dim: true }]] : result(entry.text, { color: 'yellow' });
  return [...body, []];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Printable ASCII is one column per character and every character is its own
// grapheme, except where it borders other text (combining marks, prepended
// characters). Inside a run, skip segmentation and width lookups.
const ascii = /[\x20-\x7e]{3,}/gu;
// Output repeats the same few wide graphemes; their width lookup is the slow part.
const widths = new Map<string, number>();
const graphemeWidth = (segment: string) => {
  let width = widths.get(segment);
  if (width === undefined) {
    if (widths.size > 10_000) widths.clear();
    widths.set(segment, width = stringWidth(segment));
  }
  return width;
};

/** Split styled rows to the terminal width so scrolling moves by screen rows. */
export function wrapLines(rows: Row[], width: number): Row[] {
  return rows.flatMap(row => {
    const lines: Row[] = [];
    let line: Row = [], used = 0;
    for (const span of row) {
      let text = '';
      const fits = (size: number) => {
        if (used + size <= width || !used) return;
        if (text) line.push({ ...span, text });
        lines.push(line); line = []; used = 0; text = '';
      };
      const segments = (part: string) => {
        if (!part) return;
        for (const { segment } of segmenter.segment(part)) {
          const size = graphemeWidth(segment);
          fits(size);
          text += segment; used += size;
        }
      };
      let done = 0;
      for (const match of span.text.matchAll(ascii)) {
        const start = match.index + (match.index ? 1 : 0);
        const end = match.index + match[0].length - (match.index + match[0].length < span.text.length ? 1 : 0);
        if (end <= start) continue;
        segments(span.text.slice(done, start));
        for (let offset = start; offset < end;) {
          fits(1);
          const size = Math.max(1, Math.min(end - offset, width - used));
          text += span.text.slice(offset, offset + size); used += size; offset += size;
        }
        done = end;
      }
      segments(span.text.slice(done));
      if (text) line.push({ ...span, text });
    }
    return [...lines, line];
  });
}

// Entries are immutable, so each one's wrapped rows are reused until it changes.
const wrapped = new WeakMap<Entry, { width: number; lines: Row[] }>();
/** The Ctrl+O transcript wrapped to `width`. */
export function transcriptRows(entries: Entry[], width: number): Row[] {
  return entries.flatMap(entry => {
    const cached = wrapped.get(entry);
    if (cached?.width === width) return cached.lines;
    const lines = wrapLines(entryLines(entry), width);
    wrapped.set(entry, { width, lines });
    return lines;
  });
}

export function Transcript({ entries, rows, columns, close }: { entries: Entry[]; rows: number; columns: number; close(): void }) {
  const width = Math.max(10, columns - 1);
  const lines = useMemo(() => transcriptRows(entries, width), [entries, width]);
  const height = Math.max(1, rows - 4);
  const [offset, setOffset] = useState(0);
  const limit = Math.max(0, lines.length - height);
  useInput((input, key) => {
    if (key.escape || key.ctrl && ['o', 'c'].includes(input) || input === 'q') { close(); return; }
    const step = key.upArrow || input === 'k' ? 1 : key.downArrow || input === 'j' ? -1 : key.pageUp ? height : key.pageDown ? -height : key.home || input === 'g' ? limit : key.end || input === 'G' ? -limit : 0;
    if (step) setOffset(value => Math.max(0, Math.min(limit, value + step)));
  });
  const start = Math.max(0, lines.length - height - Math.min(offset, limit));
  return <Box flexDirection="column" flexShrink={0}>
    <Rule color="green"><Text dimColor wrap="truncate-end">Showing detailed transcript · ↑/↓ PgUp/PgDn to scroll · Esc or Ctrl+O to close</Text></Rule>
    {lines.slice(start, start + height).map((line, i) => <StyledRow key={start + i} row={line} />)}
  </Box>;
}
