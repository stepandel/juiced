import React from 'react';
import { Box, Text } from 'ink';

type Span = { text: string; bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean; dim?: boolean };

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

function Line({ parts, color }: { parts: Span[]; color?: string }) {
  return <Text {...(color ? { color } : {})}>{parts.map((part, i) => <Text key={i} bold={part.bold ?? false} italic={part.italic ?? false} strikethrough={part.strikethrough ?? false} dimColor={part.dim ?? false} {...(part.code ? { color: 'cyan' } : {})}>{part.text}</Text>)}</Text>;
}

/** Assistant text as Claude Code prints it: rendered emphasis, no fences or heading markers. */
export function Markdown({ text }: { text: string }) {
  const rows: React.ReactNode[] = [];
  let fence: string | undefined;
  text.split('\n').forEach((raw, i) => {
    const marker = /^\s*(```+|~~~+)/u.exec(raw)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) { fence = fence ? undefined : marker; return; }
    if (fence) { rows.push(<Text key={i} color="cyan">{raw || ' '}</Text>); return; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/u.exec(raw);
    if (heading) { rows.push(<Line key={i} parts={spans(heading[2]!, { bold: true, italic: heading[1]!.length === 1 })} />); return; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(raw)) { rows.push(<Text key={i} dimColor>{'─'.repeat(40)}</Text>); return; }
    const quote = /^\s*>\s?(.*)$/u.exec(raw);
    if (quote) { rows.push(<Text key={i} dimColor italic>▎ {quote[1]}</Text>); return; }
    const item = /^(\s*)[-*+]\s+(.*)$/u.exec(raw);
    if (item) { rows.push(<Line key={i} parts={[{ text: `${item[1]}- ` }, ...spans(item[2]!)]} />); return; }
    rows.push(raw ? <Line key={i} parts={spans(raw)} /> : <Text key={i}> </Text>);
  });
  return <Box flexDirection="column">{rows}</Box>;
}
