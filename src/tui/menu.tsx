import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { plain } from './conversation.js';
import { cursorParts, edit, type Editor } from './editor.js';

export type MenuResult = MenuPage | { message: string } | { draft: string } | undefined;
export type MenuItem = { id: string; label: string; description?: string; current?: boolean; disabled?: boolean; run?(): Promise<MenuResult> | MenuResult };
export type MenuPage = {
  title: string;
  description?: string;
  items: MenuItem[];
  /** Read-only rows; unlabeled rows keep their indentation. */
  details?: { label?: string; value: string }[];
  footer?: string;
  pendingLabel?: string;
  search?: boolean;
  back?(): Promise<MenuPage> | MenuPage;
  input?: { label: string; initial?: string; submit(value: string): Promise<MenuResult> };
};
const line = (value: string) => plain(value).replace(/\s+/gu, ' ');

/** Shared local renderer: key presses never invoke a remote request. */
export function CommandMenu({ load, rows, done, cancel, active = true }: { load(): Promise<MenuPage>; rows: number; done(result: { message: string } | { draft: string }): void; cancel(): void; active?: boolean }) {
  const detailRows = Math.max(1, rows - 10);
  const state = useRef<{ page?: MenuPage; index: number; query: string; editor: Editor; pending: boolean }>({ index: 0, query: '', editor: { text: '', cursor: 0 }, pending: false });
  const history = useRef<(typeof state.current)[]>([]);
  const mounted = useRef(true);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const show = (page: MenuPage, remember = false) => {
    if (remember && state.current.page && state.current.page.title !== page.title) history.current.push({ ...state.current, pending: false });
    state.current = { page, index: Math.max(0, page.items.findIndex(item => item.current)), query: '', editor: { text: page.input?.initial ?? '', cursor: page.input?.initial?.length ?? 0 }, pending: false };
    setError(''); setLoading(false); refresh();
  };
  const result = (value: MenuResult) => {
    if (!mounted.current) return;
    state.current.pending = false;
    if (value && 'title' in value) show(value, true);
    else if (value) done(value);
    else refresh();
  };
  const run = (work: () => Promise<MenuResult> | MenuResult) => {
    if (state.current.pending) return;
    state.current.pending = true; setError(''); refresh();
    void Promise.resolve().then(work).then(result).catch(error => {
      if (!mounted.current) return;
      state.current.pending = false; setLoading(false); setError(plain((error as Error).message)); refresh();
    });
  };
  useEffect(() => {
    mounted.current = true;
    void load().then(page => { if (mounted.current) show(page); }).catch(error => {
      if (mounted.current) { setLoading(false); setError(plain((error as Error).message)); }
    });
    return () => { mounted.current = false; };
  }, [load]);
  const matches = () => {
    const current = state.current;
    if (current.page?.details) return [];
    const items = current.page?.items.filter(item => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(current.query.toLowerCase())) ?? [];
    current.index = Math.min(current.index, Math.max(0, items.length - 1));
    return items;
  };
  usePaste(value => {
    const current = state.current;
    if (current.pending || !current.page || current.page.details) return;
    if (current.page.input) current.editor = edit(current.editor, value, {});
    else if (current.page.search !== false) { current.query += line(value).slice(0, 512); current.index = 0; }
    refresh();
  }, { isActive: active });
  useInput((input, key) => {
    const current = state.current;
    if (current.pending) return;
    if (key.escape || key.ctrl && ['c', 'd'].includes(input)) {
      if (current.query) { current.query = ''; refresh(); }
      else if (history.current.length) { state.current = history.current.pop()!; setError(''); refresh(); }
      else if (current.page?.back) run(current.page.back);
      else cancel();
      return;
    }
    if (!current.page) { if (key.return && !loading) { setLoading(true); run(load); } return; }
    if (current.page.details) {
      const step = key.pageUp ? -detailRows : key.pageDown ? detailRows : key.upArrow ? -1 : key.downArrow ? 1 : 0;
      if (step) {
        current.index = Math.max(0, Math.min(current.index + step, current.page.details.length - detailRows));
        refresh();
      }
      return;
    }
    if (current.page.input) {
      if (key.return && !key.meta && !key.shift) { const value = current.editor.text.trim(); if (value) run(() => current.page!.input!.submit(value)); }
      else { current.editor = edit(current.editor, input, key); refresh(); }
      return;
    }
    const items = matches();
    if (key.upArrow || key.downArrow || key.tab || key.pageUp || key.pageDown) {
      const step = key.pageUp ? -6 : key.pageDown ? 6 : key.upArrow || key.tab && key.shift ? -1 : 1;
      current.index = items.length ? (current.index + step % items.length + items.length) % items.length : 0;
      refresh(); return;
    }
    if (key.return) {
      const item = items[current.index];
      if (item?.run && !item.disabled) {
        if (item.current) done({ message: `${item.label} is already selected.` });
        else run(item.run);
      }
      return;
    }
    if (current.page.search !== false && !key.ctrl && !key.meta) {
      if (key.backspace || key.delete) current.query = [...current.query].slice(0, -1).join('');
      else current.query = (current.query + line(input)).slice(0, 512);
      current.index = 0; refresh();
    }
  }, { isActive: active });
  const current = state.current;
  const page = current.page;
  if (page?.details) current.index = Math.max(0, Math.min(current.index, page.details.length - detailRows));
  const items = matches();
  const limit = Math.max(1, Math.min(6, rows - 14));
  const start = Math.max(0, current.index - limit + 1);
  const selected = items[current.index];
  const [before, cursor, after] = cursorParts(current.editor);
  return <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderColor="green" overflow="hidden">
    <Box height={1} flexShrink={0}><Text bold color="green" wrap="truncate-end">{page?.title ?? 'Loading menu…'}</Text></Box>
    {page?.description && <Box maxHeight={2} overflow="hidden"><Text dimColor>{line(page.description)}</Text></Box>}
    {page?.details ? <Box flexDirection="column">{page.details.slice(current.index, current.index + detailRows).map((field, i) => <Box key={current.index + i} height={1} flexShrink={0}>
      {field.label === undefined ? <Text wrap="truncate-end">{plain(field.value) || ' '}</Text> : <Text wrap="truncate-end"><Text dimColor>{line(field.label)}: </Text>{line(field.value)}</Text>}
    </Box>)}</Box> : page?.input ? <Box maxHeight={3} overflow="hidden"><Text>{line(page.input.label)}: {before}<Text inverse>{cursor}</Text>{after}</Text></Box> : <>
      {current.query && <Box height={1}><Text dimColor wrap="truncate-end">⌕ Filter: {current.query}</Text></Box>}
      {items.slice(start, start + limit).map((item, i) => {
        const selected = start + i === current.index;
        return <Box key={item.id} height={1} flexShrink={0}>
          <Text dimColor={(item.disabled ?? false) && !selected} wrap="truncate-end" {...(selected ? { color: 'green' } : {})}>{selected ? '❯' : ' '} {line(item.label)}{item.current ? ' ✔' : ''}</Text>
        </Box>;
      })}
      {page && !items.length && <Text dimColor>{current.query ? 'No matches' : 'No entries'}</Text>}
      {selected?.description && <Box maxHeight={2} overflow="hidden"><Text dimColor>{line(selected.description)}</Text></Box>}
    </>}
    {error && <Box height={1} flexShrink={0}><Text color="yellow" wrap="truncate-end">{error}</Text></Box>}
    <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-end">{loading ? 'Loading from Claude… · Esc to cancel' : current.pending ? page?.pendingLabel ?? 'Waiting for Claude…' : error && !page ? 'Enter to retry · Esc to cancel' : page?.details ? `${page.details.length > detailRows ? '↑/↓ or PgUp/PgDn to scroll · ' : ''}${page.footer ? `${page.footer} · ` : ''}Esc to go back` : page?.footer ? `${page.footer} · Esc to go back` : page?.input ? 'Enter to save · Esc to go back' : `Enter to confirm · Esc to go back · ↑/↓ to select · type to filter · ${items.length ? current.index + 1 : 0}/${items.length}`}</Text></Box>
  </Box>;
}
