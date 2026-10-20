export type Editor = { text: string; cursor: number };
type EditorKey = { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean; home?: boolean; end?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; return?: boolean; escape?: boolean; tab?: boolean };
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const positions = (text: string) => [...Array.from(segmenter.segment(text), part => part.index), text.length];

/** Local-only prompt edits; cursor offsets always land on grapheme boundaries. */
export function edit(state: Editor, input: string, key: EditorKey): Editor {
  const { text, cursor } = state;
  const stops = positions(text);
  const previous = stops.filter(at => at < cursor).at(-1) ?? 0;
  const next = stops.find(at => at > cursor) ?? text.length;
  const lineStart = cursor ? text.lastIndexOf('\n', cursor - 1) + 1 : 0;
  const end = text.indexOf('\n', cursor);
  const lineEnd = end === -1 ? text.length : end;
  const replace = (start: number, stop: number, insert = '') => ({ text: text.slice(0, start) + insert + text.slice(stop), cursor: start + insert.length });
  if (key.leftArrow) return { text, cursor: previous };
  if (key.rightArrow) return { text, cursor: next };
  if (key.home || key.ctrl && input === 'a') return { text, cursor: lineStart };
  if (key.end || key.ctrl && input === 'e') return { text, cursor: lineEnd };
  if (key.backspace) return replace(previous, cursor);
  if (key.delete) return replace(cursor, next);
  if (key.ctrl && input === 'u') return replace(lineStart, cursor);
  if (key.ctrl && input === 'k') return replace(cursor, lineEnd);
  if (key.ctrl && input === 'w') {
    const prefix = text.slice(0, cursor).replace(/\s*\S+\s*$/u, '');
    return replace(prefix.length, cursor);
  }
  if (key.upArrow || key.downArrow) {
    const column = Array.from(segmenter.segment(text.slice(lineStart, cursor))).length;
    const targetStart = key.upArrow ? (lineStart > 1 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0) : (end === -1 ? text.length : end + 1);
    const targetEnd = text.indexOf('\n', targetStart);
    const target = text.slice(targetStart, targetEnd === -1 ? text.length : targetEnd);
    const offset = positions(target)[Math.min(column, positions(target).length - 1)]!;
    return { text, cursor: targetStart + offset };
  }
  if (key.return) return replace(cursor, cursor, '\n');
  if (key.escape || key.ctrl || key.meta || !input) return state;
  // Bracketed paste is one edit. Strip terminal controls but retain newlines.
  const insert = input.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  if (Buffer.byteLength(text) + Buffer.byteLength(insert) > 512 * 1024) return state;
  return replace(cursor, cursor, insert);
}

export function cursorParts(state: Editor): [string, string, string] {
  const rest = state.text.slice(state.cursor);
  const current = segmenter.segment(rest)[Symbol.iterator]().next().value?.segment ?? ' ';
  return [state.text.slice(0, state.cursor), current === '\n' ? ' ' : current, current === '\n' ? rest : rest.slice(current.length)];
}
