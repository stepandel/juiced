import stringWidth from 'string-width';
import { InspectionIncomplete, type InspectionSnapshot, type TreeEntry } from './inspection-protocol.js';

type Status = 'matching' | 'different' | 'local only' | 'remote only' | 'excluded';
export type InspectionRow = { name: string; local?: TreeEntry | undefined; remote?: TreeEntry | undefined; localIgnored: boolean; remoteIgnored: boolean; status: Status };
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
    const status: Status = localIgnored || remoteIgnored ? 'excluded' : !a ? 'remote only' : !b ? 'local only' : a.mode === b.mode && a.oid === b.oid ? 'matching' : 'different';
    return { name, local: a, remote: b, localIgnored, remoteIgnored, status };
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
export function renderInspection(comparison: InspectionComparison, options: { action: 'ls' | 'peek'; localRoot: string; remoteRoot: string; workspace: string; workspaceId: string; includeIgnored: boolean; columns: number | undefined }): string {
  const { local, remote } = comparison;
  const rows = comparison.rows.filter(row => options.action === 'ls' || row.status !== 'matching');
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
  const cell = (entry: TreeEntry | undefined, ignored: boolean) => ignored ? '[ignored]' : entry ? inspectionText(entry.name) + (entry.mode === '040000' ? '/' : entry.mode === '120000' ? ' @' : '') : '-';
  const cells = rows.map(row => ({ left: cell(row.local, row.localIgnored), right: cell(row.remote, row.remoteIgnored), status: row.status }));
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
  if (counts.has('excluded')) line('Incomplete comparison: use --include-ignored PATH to compare excluded entries.');
  if (rows.some(row => row.local?.mode === '040000' || row.remote?.mode === '040000')) line('Inspect a directory with: juiced claude peek PATH');
  return lines.join('\n') + '\n';
}
