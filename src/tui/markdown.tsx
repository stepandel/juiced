import React from 'react';
import { Box, Text } from 'ink';

export type Span = { text: string; bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean; dim?: boolean; color?: string };

// Inline Markdown in the order Claude Code's renderer resolves it: code spans
// first, so markers inside backticks stay literal.
const inline = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|(?<![\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

export function spans(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  const result: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(inline)) {
    if (match.index > last) result.push({ ...style, text: text.slice(last, match.index) });
    const [, , code, bold, underscored, struck, italic, emphasized, label, url] = match;
    if (code !== undefined) result.push({ ...style, code: true, text: code.trim() || code });
    else if (bold !== undefined || underscored !== undefined) result.push(...spans((bold ?? underscored)!, { ...style, bold: true }));
    else if (struck !== undefined) result.push(...spans(struck, { ...style, strikethrough: true }));
    else if (italic !== undefined || emphasized !== undefined) result.push(...spans((italic ?? emphasized)!, { ...style, italic: true }));
    else if (label !== undefined) {
      result.push(...spans(label, style));
      if (url !== label) result.push({ ...style, dim: true, text: ` (${url})` });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) result.push({ ...style, text: text.slice(last) });
  return result;
}

export type Row = Span[];

const fenceMarker = /^\s*(```+|~~~+)/u;
/** The fence a line opens or closes, given the fence it starts in. */
const nextFence = (raw: string, fence: string | undefined): string | undefined | false => {
  const marker = fenceMarker.exec(raw)?.[1];
  return marker && (!fence || marker.startsWith(fence)) ? fence ? undefined : marker : false;
};

function rowsFrom(lines: string[], fence: string | undefined): Row[] {
  const rows: Row[] = [];
  for (const raw of lines) {
    const toggled = nextFence(raw, fence);
    if (toggled !== false) { fence = toggled; continue; }
    if (fence) { rows.push([{ text: raw, code: true }]); continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/u.exec(raw);
    if (heading) { rows.push(spans(heading[2]!, { bold: true, ...(heading[1]!.length === 1 ? { italic: true } : {}) })); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(raw)) { rows.push([{ text: '─'.repeat(40), dim: true }]); continue; }
    const quote = /^\s*>\s?(.*)$/u.exec(raw);
    if (quote) { rows.push([{ text: '▎ ', dim: true }, ...spans(quote[1]!, { dim: true, italic: true })]); continue; }
    const item = /^(\s*)[-*+]\s+(.*)$/u.exec(raw);
    if (item) { rows.push([{ text: `${item[1]}- ` }, ...spans(item[2]!)]); continue; }
    rows.push(spans(raw));
  }
  return rows;
}

/** Assistant text as styled rows: rendered emphasis, no fences or heading markers. */
export function markdownRows(text: string): Row[] {
  return rowsFrom(text.split('\n'), undefined);
}

// Fence state at a line offset, resumed from the last scan of the same growing
// text so a streaming block is scanned once overall rather than once per delta.
type Scan = { text: string; offset: number; fence: string | undefined };
const scans: Scan[] = [];
function fenceAt(text: string, offset: number): string | undefined {
  let scan = scans.find(item => item.offset <= offset && text.startsWith(item.text));
  if (!scan) {
    scan = { text: '', offset: 0, fence: undefined };
    scans.unshift(scan);
    if (scans.length > 4) scans.pop();
  }
  for (let start = scan.offset; start < offset;) {
    const end = text.indexOf('\n', start);
    const toggled = nextFence(text.slice(start, end), scan.fence);
    if (toggled !== false) scan.fence = toggled;
    start = end + 1;
  }
  scan.text = text.slice(0, offset); scan.offset = offset;
  return scan.fence;
}

/** The last `count` rows of `markdownRows(text)`, parsing only the trailing lines. */
export function markdownTail(text: string, count: number): Row[] {
  if (count <= 0) return [];
  // Fence markers yield no row, so walk back until enough lines certainly do.
  let start = text.length;
  for (let found = 0, end = text.length; ; end = start - 1) {
    start = end ? text.lastIndexOf('\n', end - 1) + 1 : 0;
    if (!fenceMarker.test(text.slice(start, end))) found++;
    if (found >= count || !start) break;
  }
  return rowsFrom(text.slice(start).split('\n'), start ? fenceAt(text, start) : undefined).slice(-count);
}

export function StyledRow({ row }: { row: Row }) {
  if (!row.some(part => part.text)) return <Text> </Text>;
  return <Text>{row.map((part, i) => <Text key={i} bold={part.bold ?? false} italic={part.italic ?? false} strikethrough={part.strikethrough ?? false} dimColor={part.dim ?? false} {...(part.code ? { color: 'cyan' } : part.color ? { color: part.color } : {})}>{part.text}</Text>)}</Text>;
}

/** With `tail`, only the last rows: the live area shows the terminal's bottom rows anyway. */
export function Markdown({ text, tail }: { text: string; tail?: number | undefined }) {
  return <Box flexDirection="column">{(tail === undefined ? markdownRows(text) : markdownTail(text, tail)).map((row, i) => <StyledRow key={i} row={row} />)}</Box>;
}
