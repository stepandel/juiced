import stringWidth from 'string-width';
import { InspectionIncomplete, type InspectionListing, type ListingEntry, type InspectionSnapshot, type TreeEntry } from './inspection-protocol.js';

type Status = 'matching' | 'different' | 'local only' | 'remote only' | 'excluded';
export type InspectionRow = { name: string; local?: TreeEntry | undefined; remote?: TreeEntry | undefined; localIgnored: boolean; remoteIgnored: boolean; localSubmodule: boolean; remoteSubmodule: boolean; status: Status };
export type InspectionComparison = { local: InspectionSnapshot; remote: InspectionSnapshot; rows: InspectionRow[] };
export function compareInspection(local: InspectionSnapshot, remote: InspectionSnapshot): InspectionComparison {
  if (local.scope !== remote.scope || local.objectFormat !== remote.objectFormat) throw new InspectionIncomplete('The workspace snapshots have incompatible scopes or Git object formats.');
  const oneEntry = local.kind === 'file' || remote.kind === 'file' || local.kind === 'ignored' || remote.kind === 'ignored';
  const left = new Map((oneEntry ? local.entry ? [local.entry] : [] : local.entries).map(entry => [entry.name, entry]));
  const right = new Map((oneEntry ? remote.entry ? [remote.entry] : [] : remote.entries).map(entry => [entry.name, entry]));
  const selected = local.scope.split('/').at(-1) ?? '(root)';
  const names = new Set([...left.keys(), ...right.keys(), ...(oneEntry && (local.kind === 'ignored' || remote.kind === 'ignored') ? [selected] : [])]);
  const rows = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(name => {
    const a = left.get(name), b = right.get(name);
    const localIgnored = !a && (oneEntry ? local.kind === 'ignored' : local.ignored.includes(name));
    const remoteIgnored = !b && (oneEntry ? remote.kind === 'ignored' : remote.ignored.includes(name));
    const localSubmodule = a?.mode === '160000' || local.submodules?.includes(name) === true;
    const remoteSubmodule = b?.mode === '160000' || remote.submodules?.includes(name) === true;
    const status: Status = localIgnored || remoteIgnored || localSubmodule || remoteSubmodule ? 'excluded' : !a ? 'remote only' : !b ? 'local only' : a.mode === b.mode && a.oid === b.oid ? 'matching' : 'different';
    return { name, local: a, remote: b, localIgnored, remoteIgnored, localSubmodule, remoteSubmodule, status };
  });
  return { local, remote, rows };
}

// Printable Unicode stays readable; control characters cannot alter the terminal.
export function inspectionText(value: string) { return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`); }
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ESCAPE = /(\\u[\da-f]{4})/, ESCAPES = new RegExp(ESCAPE, 'g');
// Paths and names break anywhere: every grapheme is kept and no column can overflow.
// An escape stays whole wherever it fits, so a wrapped name never reads as content.
function wrap(value: string, columns: number): string[] {
  const lines: string[] = []; let line = '';
  const add = (unit: string) => {
    if (stringWidth(line + unit) > columns && line) { lines.push(line); line = ''; }
    line += unit;
  };
  for (const part of value.split(ESCAPES)) {
    if (ESCAPE.test(part) && part.length === 6 && columns >= 6) add(part);
    else for (const { segment } of segments.segment(part)) add(segment);
  }
  lines.push(line); return lines;
}
// Prose keeps whole words together, falling back to grapheme breaks for words that cannot fit.
function wrapWords(value: string, columns: number): string[] {
  const lines: string[] = [];
  for (const word of value.split(' ')) {
    const line = lines.at(-1);
    if (line !== undefined && stringWidth(`${line} ${word}`) <= columns) lines[lines.length - 1] = `${line} ${word}`;
    else lines.push(...wrap(word, columns));
  }
  return lines.length ? lines : [''];
}
const pad = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - stringWidth(value)));

type Style = (value: string) => string;
const plain: Style = value => value;
// One SGR span per fragment, applied after the width maths so styling never shifts a column.
const sgr = (...codes: number[]): Style => value => value ? `\u001b[${codes.join(';')}m${value}\u001b[0m` : value;
type Theme = { muted: Style; strong: Style; glyph: Record<Status, Style>; name: Record<Status, Style> };
const UNSTYLED: Theme = {
  muted: plain, strong: plain,
  glyph: { matching: plain, different: plain, 'local only': plain, 'remote only': plain, excluded: plain },
  name: { matching: plain, different: plain, 'local only': plain, 'remote only': plain, excluded: plain },
};
// Matching rows recede so differences carry the colour; each side keeps its own hue.
const STYLED: Theme = {
  muted: sgr(2), strong: sgr(1),
  glyph: { matching: sgr(2), different: sgr(1, 33), 'local only': sgr(1, 36), 'remote only': sgr(1, 35), excluded: sgr(1, 31) },
  name: { matching: sgr(2), different: sgr(33), 'local only': sgr(36), 'remote only': sgr(35), excluded: plain },
};
const GLYPHS: Record<Status, string> = { matching: '=', different: '!', 'local only': 'L', 'remote only': 'R', excluded: '?' };
const STATUSES = ['matching', 'different', 'local only', 'remote only', 'excluded'] as const;
const ABSENT = '-', IGNORED = '[ignored]', CONTAINS = ' [contains submodule]';
const INDENT = 2, STACKED = 30;

type Layout = { columns: number | undefined; theme: Theme };
// Styled text indented as a block; a hanging indent keeps continuations under their first line.
function block(value: string, style: Style, indent: number, { columns }: Layout, words = true): string[] {
  const left = columns === undefined ? indent : Math.min(indent, Math.max(0, columns - 1));
  const width = columns === undefined ? undefined : Math.max(1, columns - left);
  const parts = width === undefined ? [value] : words ? wrapWords(value, width) : wrap(value, width);
  return parts.map(part => ' '.repeat(left) + style(part));
}
const cellText = (text: string, width: number, style: Style) => style(text) + ' '.repeat(Math.max(0, width - stringWidth(text)));
// Short labelled items share a line while they fit, so counts read as one legend instead of a column.
function pack(items: { text: string; styled: string }[], layout: Layout, gap = 3): string[] {
  const limit = layout.columns === undefined ? Infinity : Math.max(1, layout.columns);
  const lines: string[] = []; let current: typeof items = [], width = INDENT;
  const flush = () => { if (current.length) lines.push(' '.repeat(INDENT) + current.map(item => item.styled).join(' '.repeat(gap))); current = []; width = INDENT; };
  for (const item of items) {
    const size = stringWidth(item.text);
    if (current.length && width + gap + size > limit) flush();
    if (!current.length && INDENT + size > limit) { lines.push(...block(item.text, plain, INDENT, layout)); continue; }
    width += current.length ? gap + size : size;
    current.push(item);
  }
  flush();
  return lines;
}

type HeaderRow = { label: string; value: string; aux?: string | undefined };
// Each side's path sits beside its Git ref, aligned into one block when the terminal allows.
function renderHeader(rows: HeaderRow[], layout: Layout): string[] {
  const { columns, theme } = layout;
  const labelWidth = Math.max(...rows.map(row => stringWidth(row.label)));
  const valueWidth = Math.max(...rows.map(row => stringWidth(row.value)));
  const auxWidth = Math.max(0, ...rows.map(row => stringWidth(row.aux ?? '')));
  const start = INDENT + labelWidth + 2, limit = columns ?? Infinity;
  const aligned = rows.every(row => start + valueWidth + (row.aux ? 2 + auxWidth : 0) <= limit);
  const lines: string[] = [];
  for (const row of rows) {
    const fits = start + stringWidth(row.value) + (row.aux ? 2 + stringWidth(row.aux) : 0) <= limit;
    if (aligned || fits) {
      const value = pad(row.value, aligned ? valueWidth : 0);
      lines.push((' '.repeat(INDENT) + theme.muted(pad(row.label, labelWidth)) + '  ' + value + (row.aux ? '  ' + theme.muted(row.aux) : '')).trimEnd());
    } else {
      lines.push(' '.repeat(INDENT) + theme.muted(row.label));
      lines.push(...block(row.value, plain, INDENT + 2, layout, false));
      if (row.aux) lines.push(...block(row.aux, theme.muted, INDENT + 2, layout, false));
    }
  }
  return lines;
}

type Cell = { status: Status; label: string; left: string; right: string; leftStyle: Style; rightStyle: Style; detail: string | undefined };
// Columns take their natural width and only share the terminal when the names cannot all fit.
function renderTable(cells: Cell[], layout: Layout): string[] {
  const { columns, theme } = layout;
  let leftWidth = Math.max(5, ...cells.map(cell => stringWidth(cell.left)));
  let rightWidth = Math.max(6, ...cells.map(cell => stringWidth(cell.right)));
  if (columns !== undefined) {
    const available = Math.max(2, columns - INDENT - 5);
    if (leftWidth + rightWidth > available) { leftWidth = Math.max(1, Math.floor(available / 2)); rightWidth = Math.max(1, available - leftWidth); }
  }
  const lines = [' '.repeat(INDENT) + theme.muted(`${pad('LOCAL', leftWidth)}     REMOTE`)];
  for (const cell of cells) {
    const left = columns === undefined ? [cell.left] : wrap(cell.left, leftWidth);
    const right = columns === undefined ? [cell.right] : wrap(cell.right, rightWidth);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const glyph = i ? ' ' : theme.glyph[cell.status](GLYPHS[cell.status]);
      lines.push((' '.repeat(INDENT) + cellText(left[i] ?? '', leftWidth, cell.leftStyle) + '  ' + glyph + '  ' + cell.rightStyle(right[i] ?? '')).trimEnd());
    }
  }
  return lines;
}
// Narrow terminals name each entry once and annotate it only where the two sides disagree.
function renderStacked(cells: Cell[], layout: Layout): string[] {
  const { columns, theme } = layout;
  const width = columns === undefined ? undefined : Math.max(1, columns - INDENT - 2);
  const lines: string[] = [];
  for (const cell of cells) {
    const name = width === undefined ? [cell.label] : wrap(cell.label, width);
    lines.push(' '.repeat(INDENT) + theme.glyph[cell.status](GLYPHS[cell.status]) + ' ' + theme.name[cell.status](name[0] ?? ''));
    for (const part of name.slice(1)) lines.push(' '.repeat(INDENT + 2) + theme.name[cell.status](part));
    if (cell.detail) lines.push(...block(cell.detail, theme.muted, INDENT + 2, layout));
  }
  return lines;
}

type ListingOptions = { remoteRoot: string; workspace: string; workspaceId: string; includeIgnored: boolean; columns: number | undefined; color: boolean };
const entryText = (entry: ListingEntry) => inspectionText(entry.name) + (entry.mode === '040000' ? '/' : entry.mode === '120000' ? ' @' : entry.mode === '160000' ? '/ [submodule]' : '');
const ignoreNote = (includeIgnored: boolean) => includeIgnored ? 'Git view; ignored files included in the selected path.' : 'Git view; ignored files excluded.';
const layoutOf = (options: ListingOptions): Layout => ({ columns: options.columns === undefined ? undefined : Math.max(1, options.columns), theme: options.color ? STYLED : UNSTYLED });

export function renderRemoteListing(snapshot: InspectionListing, options: ListingOptions): string {
  const layout = layoutOf(options), { theme } = layout;
  const lines = renderHeader([
    { label: 'Workspace', value: inspectionText(options.workspace), aux: options.workspaceId },
    { label: 'Remote', value: inspectionText(options.remoteRoot) },
  ], layout);
  lines.push('');
  if (snapshot.kind === 'ignored') lines.push(...block('Path is ignored. Use --include-ignored PATH to list it.', theme.muted, INDENT, layout));
  else if (snapshot.kind === 'missing') lines.push(...block('Path absent in the remote workspace.', theme.muted, INDENT, layout));
  else {
    const entries = [...(snapshot.kind === 'file' ? [snapshot.entry!] : snapshot.entries)].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) lines.push(...block(entryText(entry), entry.mode === '040000' || entry.mode === '160000' ? theme.strong : entry.mode === '120000' ? theme.muted : plain, INDENT, layout, false));
    if (!entries.length) lines.push(...block('No Git-visible entries in this scope.', theme.muted, INDENT, layout));
    lines.push('');
    lines.push(...block(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`, theme.muted, INDENT, layout));
    if (entries.some(entry => entry.mode === '160000')) lines.push(...block('Submodules and nested Git repositories are listed without inspecting their contents.', theme.muted, INDENT, layout));
  }
  lines.push(...block(ignoreNote(options.includeIgnored), theme.muted, INDENT, layout));
  return lines.join('\n') + '\n';
}

export function renderInspection(comparison: InspectionComparison, options: ListingOptions & { changesOnly: boolean; localRoot: string }): string {
  const { local, remote } = comparison;
  const layout = layoutOf(options), { columns, theme } = layout;
  const rows = comparison.rows.filter(row => !options.changesOnly || row.status !== 'matching');
  const ref = (snapshot: InspectionSnapshot) => `${inspectionText(snapshot.branch ?? 'detached')} ${snapshot.head.slice(0, 12)}`;
  const lines = renderHeader([
    { label: 'Workspace', value: inspectionText(options.workspace), aux: options.workspaceId },
    { label: 'Local', value: inspectionText(options.localRoot) + (local.scope ? '/' + inspectionText(local.scope) : ''), aux: ref(local) },
    { label: 'Remote', value: inspectionText(options.remoteRoot), aux: ref(remote) },
  ], layout);
  // A submodule names itself; a directory that merely holds one says so, since its contents stay uncompared.
  const cell = (entry: TreeEntry | undefined, ignored: boolean, submodule: boolean) =>
    ignored ? IGNORED : entry ? entryText(entry) + (submodule && entry.mode !== '160000' ? CONTAINS : '') : ABSENT;
  const cells = rows.map((row): Cell => {
    const left = cell(row.local, row.localIgnored, row.localSubmodule);
    const right = cell(row.remote, row.remoteIgnored, row.remoteSubmodule);
    const side = (text: string) => text === ABSENT || text === IGNORED ? theme.muted : theme.name[row.status];
    const ignored = row.localIgnored || row.remoteIgnored;
    return {
      status: row.status, left, right, leftStyle: side(left), rightStyle: side(right),
      label: row.local ? entryText(row.local) : row.remote ? entryText(row.remote) : inspectionText(row.name),
      detail: row.status === 'local only' ? 'only in local' : row.status === 'remote only' ? 'only in remote'
        : row.status === 'excluded' ? ignored ? `ignored in ${row.localIgnored && row.remoteIgnored ? 'both' : row.localIgnored ? 'local' : 'remote'}` : 'contents not compared'
        : left === right ? undefined : `local ${left}, remote ${right}`,
    };
  });
  lines.push('');
  if (!rows.length) lines.push(...block(comparison.rows.length ? 'No differences observed.' : local.kind === 'missing' && remote.kind === 'missing' ? 'Path absent on both sides.' : 'No Git-visible entries in this scope.', theme.muted, INDENT, layout));
  else lines.push(...(columns !== undefined && columns < STACKED ? renderStacked(cells, layout) : renderTable(cells, layout)));
  lines.push('');
  const counts = new Map<Status, number>();
  for (const row of comparison.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  // The glyph beside each count doubles as the table's legend, and absent statuses stay out of the way.
  lines.push(...pack(STATUSES.filter(status => counts.get(status)).map(status => ({
    text: `${GLYPHS[status]} ${counts.get(status)} ${status}`,
    styled: `${theme.glyph[status](GLYPHS[status])} ${counts.get(status)} ${theme.muted(status)}`,
  })), layout));
  lines.push(...block(`${ignoreNote(options.includeIgnored)} One level; directory status includes descendants. Sequential live reads.`, theme.muted, INDENT, layout));
  if (comparison.rows.some(row => row.localIgnored || row.remoteIgnored)) lines.push(...block('Incomplete comparison: use --include-ignored PATH to compare ignored entries.', theme.muted, INDENT, layout));
  if (comparison.rows.some(row => row.localSubmodule || row.remoteSubmodule)) lines.push(...block('Incomplete comparison: submodules and nested Git repository contents are excluded. Inspect another path to compare the remaining files.', theme.muted, INDENT, layout));
  if (rows.some(row => row.local?.mode === '040000' || row.remote?.mode === '040000')) lines.push(...block('Drill into a directory: juiced claude peek PATH', theme.muted, INDENT, layout));
  return lines.join('\n') + '\n';
}
