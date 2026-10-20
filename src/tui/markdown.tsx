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

/** Assistant text as styled rows: rendered emphasis, no fences or heading markers. */
export function markdownRows(text: string): Row[] {
  const rows: Row[] = [];
  let fence: string | undefined;
  for (const raw of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/u.exec(raw)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) { fence = fence ? undefined : marker; continue; }
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

export function StyledRow({ row }: { row: Row }) {
  if (!row.some(part => part.text)) return <Text> </Text>;
  return <Text>{row.map((part, i) => <Text key={i} bold={part.bold ?? false} italic={part.italic ?? false} strikethrough={part.strikethrough ?? false} dimColor={part.dim ?? false} {...(part.code ? { color: 'cyan' } : part.color ? { color: part.color } : {})}>{part.text}</Text>)}</Text>;
}

export function Markdown({ text }: { text: string }) {
  return <Box flexDirection="column">{markdownRows(text).map((row, i) => <StyledRow key={i} row={row} />)}</Box>;
}
