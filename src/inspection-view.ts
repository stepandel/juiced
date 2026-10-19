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
function wrap(value: string, columns: number): string[] {
  const lines: string[] = []; let line = '';
  for (const { segment } of segments.segment(value)) {
    if (stringWidth(line + segment) > columns && line) { lines.push(line); line = ''; }
    line += segment;
  }
  lines.push(line); return lines;
}
const pad = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - stringWidth(value)));
type ListingOptions = { remoteRoot: string; workspace: string; workspaceId: string; includeIgnored: boolean; columns: number | undefined };
const entryText = (entry: ListingEntry) => inspectionText(entry.name) + (entry.mode === '040000' ? '/' : entry.mode === '120000' ? ' @' : entry.mode === '160000' ? '/ [submodule]' : '');
export function renderRemoteListing(snapshot: InspectionListing, options: ListingOptions): string {
  const lines: string[] = [];
  const line = (text: string) => lines.push(...(options.columns ? wrap(text, Math.max(1, options.columns)) : [text]));
  line(`Workspace: ${inspectionText(options.workspace)} (${options.workspaceId})`);
  line(`Remote: ${inspectionText(options.remoteRoot)}`);
  line(options.includeIgnored ? 'Git view; ignored files included in the selected path.' : 'Git view; ignored files excluded.');
  lines.push('');
  if (snapshot.kind === 'ignored') line('Path is ignored. Use --include-ignored PATH to list it.');
  else if (snapshot.kind === 'missing') line('Path absent in the remote workspace.');
  else {
    const entries = snapshot.kind === 'file' ? [snapshot.entry!] : snapshot.entries;
    for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) line(entryText(entry));
    if (entries.some(entry => entry.mode === '160000')) line('Submodules and nested Git repositories are listed without inspecting their contents.');
    if (!entries.length) line('No Git-visible entries in this scope.');
    lines.push(''); line(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`);
  }
  return lines.join('\n') + '\n';
}
export function renderInspection(comparison: InspectionComparison, options: ListingOptions & { changesOnly: boolean; localRoot: string }): string {
  const { local, remote } = comparison;
  const rows = comparison.rows.filter(row => !options.changesOnly || row.status !== 'matching');
  const columns = options.columns === undefined ? undefined : Math.max(1, options.columns);
  const lines: string[] = [];
  const line = (text: string) => lines.push(...(columns ? wrap(text, columns) : [text]));
  line(`Workspace: ${inspectionText(options.workspace)} (${options.workspaceId})`);
  line(`Local: ${inspectionText(options.localRoot)}${local.scope ? '/' + inspectionText(local.scope) : ''}`);
  line(`Remote: ${inspectionText(options.remoteRoot)}`);
  line(`Local HEAD: ${inspectionText(local.branch ?? 'detached')} ${local.head.slice(0, 12)}`);
  line(`Remote HEAD: ${inspectionText(remote.branch ?? 'detached')} ${remote.head.slice(0, 12)}`);
  line(options.includeIgnored ? 'Git view; ignored files included in the selected path.' : 'Git view; ignored files excluded.');
  line('One level; directory status includes descendants. Sequential live reads.');
  lines.push('');
  const cell = (entry: TreeEntry | undefined, ignored: boolean, submodule: boolean) => ignored ? '[ignored]' : entry ? entryText(entry) + (submodule && entry.mode !== '160000' ? ' [contains submodule]' : '') : '-';
  const cells = rows.map(row => ({ left: cell(row.local, row.localIgnored, row.localSubmodule), right: cell(row.remote, row.remoteIgnored, row.remoteSubmodule), status: row.status }));
  const leftWidth = columns ? Math.max(1, Math.floor((columns - 3) / 2)) : Math.max(5, ...cells.map(row => stringWidth(row.left)));
  const rightWidth = columns ? Math.max(1, columns - leftWidth - 3) : undefined;
  if (rows.length && (!columns || columns >= 30)) {
    lines.push(`${pad('LOCAL', leftWidth)}   REMOTE`);
    const symbols: Record<Status, string> = { matching: '=', different: '!', 'local only': 'L', 'remote only': 'R', excluded: '?' };
    for (const row of cells) {
      const a = columns ? wrap(row.left, leftWidth) : [row.left], b = rightWidth ? wrap(row.right, rightWidth) : [row.right];
      for (let i = 0; i < Math.max(a.length, b.length); i++) lines.push(`${pad(a[i] ?? '', leftWidth)} ${i ? ' ' : symbols[row.status]} ${b[i] ?? ''}`.trimEnd());
    }
  } else for (const row of cells) { line(`${row.status}:`); line(`Local: ${row.left}`); line(`Remote: ${row.right}`); lines.push(''); }
  if (!rows.length) line(comparison.rows.length ? 'No differences observed.' : local.kind === 'missing' && remote.kind === 'missing' ? 'Path absent on both sides.' : 'No Git-visible entries in this scope.');
  lines.push('');
  const counts = new Map<Status, number>();
  for (const row of comparison.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  line((['matching', 'different', 'local only', 'remote only', 'excluded'] as const).map(status => `${counts.get(status) ?? 0} ${status}`).join(' | '));
  if (comparison.rows.some(row => row.localIgnored || row.remoteIgnored)) line('Incomplete comparison: use --include-ignored PATH to compare ignored entries.');
  if (comparison.rows.some(row => row.localSubmodule || row.remoteSubmodule)) line('Incomplete comparison: submodules and nested Git repository contents are excluded. Inspect another path to compare the remaining files.');
  if (rows.some(row => row.local?.mode === '040000' || row.remote?.mode === '040000')) line('Inspect a directory with: juiced claude peek PATH');
  return lines.join('\n') + '\n';
}
