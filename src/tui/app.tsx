import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, Static, render, useInput, usePaste } from 'ink';
import stringWidth from 'string-width';
import { object, type Approval, type ApprovalOptions, type ClaudeFrame, type SlashCommand } from '../agent-protocol.js';
import { RemoteAgent, type AgentStatus } from '../remote-agent.js';
import type { TerminalIO } from '../remote-terminal.js';
import { cursorParts, edit, type Editor } from './editor.js';
import { duration, emptyConversation, liveEntries, plain, receiveFrame, restoreHistory, toolSummary, turnTokens, userTurn, type Entry } from './conversation.js';
import { Entries, Header } from './transcript.js';
import { markdownRows, StyledRow, type Row, type Span } from './markdown.js';
import { availableCommands, matchingCommands } from './commands.js';
import { CommandMenu, type MenuPage } from './menu.js';
import { commandMenu, menuCommand } from './command-menus.js';

type Draft = { current: Editor };
function useDraft(): [Draft, (next: Editor) => void] {
  const current = useRef<Editor>({ text: '', cursor: 0 });
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  // Multiple key events can arrive before React commits a render. Keep their
  // edits synchronous so rapid typing never reads an earlier cursor or draft.
  return [current, next => { current.current = next; refresh(); }];
}

function Clipped({ children, tail = false }: { children: React.ReactNode; tail?: boolean }) {
  return <Box flexDirection="column" overflow="hidden" justifyContent={tail ? 'flex-end' : 'flex-start'}>
    <Box flexDirection="column" flexShrink={0}>{children}</Box>
  </Box>;
}

/** A horizontal rule above (and optionally below) its content, like Claude Code's prompt and dialogs. */
function Rule({ color, bottom = false, indent = 0, children }: { color: string; bottom?: boolean; indent?: number; children: React.ReactNode }) {
  return <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={bottom} borderColor={color} paddingLeft={indent} overflow="hidden">{children}</Box>;
}

const glyphs = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const spinnerVerbs = ['Thinking', 'Juicing', 'Squeezing', 'Pondering', 'Brewing', 'Cogitating', 'Churning', 'Crunching', 'Percolating', 'Simmering', 'Mulling', 'Blending', 'Zesting', 'Pulping', 'Noodling'];
const compact = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/u, '')}k` : String(count);

function Spinner({ label, since, tokens }: { label: string; since?: number | undefined; tokens?: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => { const timer = setInterval(() => setFrame(value => value + 1), 120); return () => clearInterval(timer); }, []);
  const detail = since === undefined ? [] : [duration(Date.now() - since), ...(tokens ? [`↓ ${compact(tokens)} tokens`] : [])];
  return <Text wrap="truncate-end"><Text color="cyan">{glyphs[frame % glyphs.length]} {label}…</Text><Text dimColor>{detail.length ? ` (${detail.join(' · ')})` : ''}</Text></Text>;
}

const modes: Record<string, [string, string]> = {
  default: ['⏸', 'manual mode on'], acceptEdits: ['⏵⏵', 'accept edits on'], plan: ['⏸', 'plan mode on'],
  auto: ['⏵⏵', 'auto mode on'], dontAsk: ['⏵⏵', 'don’t ask mode on'], bypassPermissions: ['⏵⏵', 'bypass permissions on'],
};
/** Claude Code's Shift+Tab order; sessions launched in bypass mode can also cycle back to it. */
export const modeCycle = ['default', 'acceptEdits', 'plan', 'auto'];
/** Auto mode depends on the account, which Claude reports only by refusing it. */
const optional = new Set(['auto']);
export type Pending = 'ctrl-c' | 'ctrl-d' | 'esc';

function Footer({ mode, pending, busy, empty, model }: { mode: string; pending?: Pending | undefined; busy: boolean; empty: boolean; model: string }) {
  const [symbol, label] = modes[mode] ?? ['⏵⏵', `${mode} mode on`];
  return <Box flexShrink={0} height={1} paddingX={2} justifyContent="space-between">
    <Box flexShrink={1}>{pending
      ? <Text dimColor wrap="truncate-end">{pending === 'esc' ? 'Esc again to clear' : `Press ${pending === 'ctrl-c' ? 'Ctrl-C' : 'Ctrl-D'} again to exit`}</Text>
      : <Text wrap="truncate-end"><Text {...(mode === 'default' ? { dimColor: true } : { color: mode === 'bypassPermissions' ? 'yellow' : 'green' })}>{symbol} {label}</Text><Text dimColor>{mode === 'default' ? '' : ' (shift+tab to cycle)'}{busy ? ' · esc to interrupt' : empty && mode === 'default' ? ' · ? for shortcuts' : ''}</Text></Text>}</Box>
    {model && <Box flexShrink={0} marginLeft={2}><Text dimColor>{model}</Text></Box>}
  </Box>;
}

const shortcuts = [
  ['/ for commands', 'shift + tab to cycle modes', 'ctrl + c to clear or exit'],
  ['esc to interrupt', 'double tap esc to clear input', 'ctrl + u/k/w to delete'],
  ['↑/↓ for prompt history', 'backslash (\\) + return (⏎) for newline', '/detach to leave Claude running'],
  ['ctrl + o for detailed transcript', '', ''],
];
function Shortcuts() {
  return <Box flexShrink={0} paddingX={2}>{[0, 1, 2].map(column => <Box key={column} flexDirection="column" width="33%" paddingRight={1}>
    {shortcuts.map(row => <Text key={row[column]} dimColor>{row[column]}</Text>)}
  </Box>)}</Box>;
}

type PromptProps = { editor: Draft; onEdit(value: Editor): void; onSubmit(value: string): void; onEscape?(): void; onHelp?(): void; onKey?(): void; onCycleMode?(): void; commands?: SlashCommand[]; history?: string[]; menuRows?: number; disabled?: boolean; placeholder?: string };
function Prompt({ editor, onEdit, onSubmit, onEscape, onHelp, onKey, onCycleMode, commands, history = [], menuRows = 5, disabled = false, placeholder = 'Ask Claude to work in your remote workspace…' }: PromptProps) {
  const menu = useRef({ query: '', index: 0, dismissed: false });
  // -1 is the unsent draft; 0 is the most recent prompt.
  const recall = useRef({ index: -1, draft: '' });
  const [, refreshMenu] = useReducer((value: number) => value + 1, 0);
  // Read the current draft for every key, including rapid arrow + Enter input.
  const suggestions = () => {
    const matches = disabled || !commands ? [] : matchingCommands(editor.current, commands);
    const query = matches.length ? editor.current.text : '';
    if (menu.current.query !== query) menu.current = { query, index: 0, dismissed: false };
    menu.current.index = Math.min(menu.current.index, Math.max(0, matches.length - 1));
    return menu.current.dismissed ? [] : matches;
  };
  const change = (value: Editor) => { recall.current.index = -1; onEdit(value); };
  usePaste(text => change(edit(editor.current, text, {})), { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && ['c', 'd'].includes(input)) return;
    if (input === '?' && !editor.current.text && onHelp) { onHelp(); return; }
    onKey?.();
    const matches = suggestions();
    if (key.escape) {
      if (matches.length) { menu.current.dismissed = true; refreshMenu(); }
      else onEscape?.();
      return;
    }
    if (matches.length && (key.upArrow || key.downArrow)) {
      menu.current.index = (menu.current.index + (key.upArrow ? -1 : 1) + matches.length) % matches.length;
      refreshMenu(); return;
    }
    const { text, cursor } = editor.current;
    if (history.length && (key.upArrow && !text.slice(0, cursor).includes('\n') || key.downArrow && !text.slice(cursor).includes('\n') && recall.current.index >= 0)) {
      const state = recall.current;
      if (state.index === -1) state.draft = text;
      state.index = Math.max(-1, Math.min(history.length - 1, state.index + (key.upArrow ? 1 : -1)));
      const value = state.index === -1 ? state.draft : history[history.length - 1 - state.index]!;
      onEdit({ text: value, cursor: value.length }); return;
    }
    if (key.tab && key.shift && !matches.length) { onCycleMode?.(); return; }
    const selected = matches[menu.current.index];
    if (selected && key.tab) {
      const value = `/${selected.name} `;
      change({ text: value, cursor: value.length }); return;
    }
    if (key.return && !key.meta && !key.shift) {
      if (text.endsWith('\\')) { change({ text: text.slice(0, -1) + '\n', cursor: text.length }); return; }
      recall.current.index = -1;
      onSubmit(selected ? `/${selected.name}` : text); return;
    }
    change(edit(editor.current, input, key));
  }, { isActive: !disabled });
  const [before, cursor, after] = cursorParts(editor.current);
  const matches = suggestions();
  const start = Math.max(0, menu.current.index - menuRows + 1);
  const label = (command: SlashCommand) => `/${command.name}${command.argumentHint ? ` ${plain(command.argumentHint).replace(/\s+/g, ' ')}` : ''}`;
  const column = Math.min(32, Math.max(0, ...matches.map(command => label(command).length)) + 2);
  return <Box flexDirection="column">
    {matches.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {matches.slice(start, start + menuRows).map((command, i) => {
        const selected = start + i === menu.current.index;
        return <Box key={command.name} height={1} paddingLeft={2}>
          <Box width={2} flexShrink={0}><Text color="green">{selected ? '❯' : ' '}</Text></Box>
          <Box width={column} flexShrink={0}><Text wrap="truncate-end" {...(selected ? { color: 'green' } : {})}>{label(command)}</Text></Box>
          <Box flexGrow={1}><Text wrap="truncate-end" {...(selected ? { color: 'green' } : { dimColor: true })}>{plain(command.description).replace(/\s+/g, ' ')}</Text></Box>
        </Box>;
      })}
    </Box>}
    <Rule bottom color={disabled ? 'gray' : 'green'}>
      <Box>
        <Box width={2} flexShrink={0}><Text color={disabled ? 'gray' : 'green'}>❯</Text></Box>
        <Box flexGrow={1}><Clipped tail><Text>{editor.current.text ? <>{before}<Text inverse={!disabled}>{cursor}</Text>{after}</> : <><Text inverse={!disabled} dimColor>{placeholder.slice(0, 1)}</Text><Text dimColor>{placeholder.slice(1)}</Text></>}</Text></Clipped></Box>
      </Box>
    </Rule>
  </Box>;
}

const dashes = { topLeft: '', top: '╌', topRight: '', left: '', right: '', bottomLeft: '', bottom: '╌', bottomRight: '' };
const lines = (value: unknown) => plain(value).replace(/\n+$/u, '').split('\n');
const path = (value: unknown) => plain(value).replace(/^\/workspace\//u, '');
/** Claude Code's per-tool permission titles, questions and previews. */
function request(approval: Approval): { title: string; question: string; body: React.ReactNode } {
  const input = approval.input;
  const dashed = (children: React.ReactNode) => <Box flexDirection="column" borderStyle={dashes} borderLeft={false} borderRight={false} borderDimColor>{children}</Box>;
  const json = plain(JSON.stringify(input, null, 2));
  const raw = <Text>{json.length > 12_000 ? json.slice(0, 12_000) + '\n[preview truncated]' : json}</Text>;
  if (approval.local) return { title: 'Apply to your local checkout', question: 'Do you want to apply these changes in your local checkout?', body: raw };
  if (approval.tool === 'Bash') return { title: 'Bash command', question: 'Do you want to proceed?', body: <Box flexDirection="column" paddingLeft={2}><Text>{plain(input.command)}</Text>{input.description ? <Text dimColor>{plain(input.description)}</Text> : null}</Box> };
  if (approval.tool === 'Write') return { title: 'Create file', question: `Do you want to create ${path(input.file_path)}?`, body: <>
    <Text>{path(input.file_path)}</Text>
    {dashed(lines(input.content).slice(0, 400).map((text, i) => <Text key={i}><Text dimColor>{String(i + 1).padStart(3)} </Text>{text}</Text>))}
  </> };
  if (approval.tool === 'Edit' || approval.tool === 'MultiEdit') {
    const edits = approval.tool === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits.map(object) : [];
    return { title: 'Edit file', question: `Do you want to make this edit to ${path(input.file_path)}?`, body: <>
      <Text>{path(input.file_path)}</Text>
      {dashed(edits.slice(0, 20).flatMap((item, n) => [
        ...lines(item.old_string).slice(0, 200).map((text, i) => <Text key={`${n}-${i}-old`} color="red">- {text}</Text>),
        ...lines(item.new_string).slice(0, 200).map((text, i) => <Text key={`${n}-${i}-new`} color="green">+ {text}</Text>),
      ]))}
    </> };
  }
  return { title: approval.tool === 'Read' ? 'Read file' : approval.tool === 'WebFetch' ? 'Fetch' : 'Tool use', question: 'Do you want to proceed?', body: <><Text>{toolSummary(approval.tool, input)}</Text>{raw}</> };
}

function Choices({ items, index, rows }: { items: { label: string; description?: string; checked?: boolean }[]; index: number; rows: number }) {
  const start = Math.max(0, Math.min(index - Math.floor(rows / 2), items.length - rows));
  return <Box flexDirection="column" flexShrink={0}>{items.slice(start, start + rows).map((item, i) => {
    const selected = start + i === index;
    return <Box key={start + i} flexDirection="column">
      <Text wrap="truncate-end" {...(selected ? { color: 'green' } : {})}>{selected ? '❯' : ' '} <Text dimColor={!selected}>{start + i + 1}.</Text> {item.checked === undefined ? '' : item.checked ? '[✓] ' : '[ ] '}{item.label}</Text>
      {item.description ? <Box paddingLeft={5}><Text dimColor wrap="truncate-end">{item.description}</Text></Box> : null}
    </Box>;
  })}</Box>;
}

function Question({ questions, rows, answer, cancel }: { questions: Record<string, unknown>[]; rows: number; answer(allow: boolean, answers?: Record<string, string>): void; cancel(): void }) {
  const opened = useRef(Date.now());
  const [editor, setEditor] = useDraft();
  const state = useRef({ question: 0, index: 0, typing: false, checked: new Set<number>(), answers: {} as Record<string, string> });
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const question = questions[state.current.question]!;
  const options = Array.isArray(question.options) ? question.options.map(object) : [];
  const multiple = question.multiSelect === true;
  const items = [
    ...options.map((option, i) => ({ label: plain(option.label), ...(option.description ? { description: plain(option.description).replace(/\s+/g, ' ') } : {}), ...(multiple ? { checked: state.current.checked.has(i) } : {}) })),
    { label: 'Type something.' }, ...(multiple ? [{ label: 'Submit' }] : []),
  ];
  const choose = (value: string) => {
    const current = state.current;
    const answers = { ...current.answers, [plain(question.question)]: value };
    if (current.question + 1 === questions.length) { answer(true, answers); return; }
    state.current = { question: current.question + 1, index: 0, typing: false, checked: new Set(), answers };
    setEditor({ text: '', cursor: 0 }); refresh();
  };
  const pick = (index: number) => {
    const current = state.current;
    if (index === options.length) { current.typing = true; refresh(); }
    else if (index > options.length) choose(options.filter((_, i) => current.checked.has(i)).map(option => String(option.label)).join(', '));
    else if (multiple) { if (!current.checked.delete(index)) current.checked.add(index); refresh(); }
    else choose(String(options[index]!.label));
  };
  usePaste(() => {}, { isActive: !state.current.typing });
  useInput((input, key) => {
    const current = state.current;
    if (key.ctrl && input === 'c') { cancel(); return; }
    if (current.typing) return;
    if (key.escape) { answer(false); return; }
    if (key.upArrow || key.downArrow || key.tab) { current.index = (current.index + (key.upArrow || key.shift ? -1 : 1) + items.length) % items.length; refresh(); }
    else if (Date.now() - opened.current < settle) return;
    else if (key.return || input === ' ' && multiple) pick(current.index);
    else if (/^[1-9]$/u.test(input) && Number(input) <= items.length) { current.index = Number(input) - 1; pick(current.index); }
  });
  return <>
    {question.header ? <Box flexShrink={0}><Text color="green">☐ {plain(question.header)}</Text></Box> : null}
    <Box flexShrink={0}><Text bold>{plain(question.question)}</Text></Box>
    {state.current.typing
      ? <Prompt editor={editor} onEdit={setEditor} placeholder="Type your answer" onEscape={() => { state.current.typing = false; refresh(); }} onSubmit={value => { if (value.trim()) choose(value.trim()); }} />
      : <Choices items={items} index={state.current.index} rows={Math.max(1, Math.floor((rows - 9) / (options.some(option => option.description) ? 2 : 1)))} />}
    <Box flexShrink={0}><Text dimColor wrap="truncate-end">{state.current.typing ? 'Enter to submit · Esc to go back' : `Enter to select · Esc to cancel · ↑/↓ to navigate${multiple ? ' · Space to toggle' : ''}`}</Text></Box>
  </>;
}

const destinations: Record<string, string> = { session: ' for this session', localSettings: ' in this project', projectSettings: ' in this project', userSettings: ' in all projects' };
/** Claude's "Yes, and don't ask again…" label for its permission suggestions. */
export function rememberLabel(suggestions: ClaudeFrame[]): string {
  const parts = suggestions.flatMap(raw => {
    const suggestion = object(raw);
    const where = destinations[String(suggestion.destination)] ?? '';
    if (suggestion.type === 'addRules' && suggestion.behavior !== 'deny') {
      const rules = Array.isArray(suggestion.rules) ? suggestion.rules.map(object) : [];
      return rules.length ? [`don’t ask again for ${rules.map(rule => rule.ruleContent ? `${plain(rule.toolName)}(${plain(rule.ruleContent)})` : plain(rule.toolName)).join(', ')}${where}`] : [];
    }
    if (suggestion.type === 'setMode') return [`switch to ${modes[String(suggestion.mode)]?.[1].replace(/ on$/u, '') ?? plain(suggestion.mode)}${where}`];
    if (suggestion.type === 'addDirectories' && Array.isArray(suggestion.directories)) return [`always allow access to ${suggestion.directories.map(plain).join(', ')}${where}`];
    return [];
  });
  return `Yes, and ${parts.length ? parts.join(' and ') : 'don’t ask again'}`;
}

/** Keys that arrive this soon after a dialog opens were meant for the prompt. */
const settle = 300;

function Permission({ approval, rows, answer, cancel }: { approval: Approval; rows: number; answer(allow: boolean, answers?: Record<string, string>, options?: ApprovalOptions): void; cancel(): void }) {
  const opened = useRef(Date.now());
  // Like Claude Code, Yes is preselected. Local application into the user's
  // checkout is a Juiced-only request and keeps No as its default.
  // A ref, so a rapid arrow then Enter confirms the newly selected choice.
  const index = useRef(approval.local ? approval.suggestions?.length ? 2 : 1 : 0);
  const [, refreshSelection] = useReducer((value: number) => value + 1, 0);
  const select = (value: number) => { index.current = (value + choices.length) % choices.length; refreshSelection(); };
  const [amending, setAmending] = useState(false);
  const [feedback, setFeedback] = useDraft();
  const questions = Array.isArray(approval.input.questions) ? approval.input.questions.map(object) : [];
  const asking = approval.tool === 'AskUserQuestion' && questions.length > 0;
  const choices: { label: string; run(): void }[] = [
    { label: 'Yes', run: () => answer(true) },
    ...(approval.suggestions?.length ? [{ label: rememberLabel(approval.suggestions), run: () => answer(true, undefined, { suggestions: approval.suggestions! }) }] : []),
    { label: approval.local ? 'No' : 'No, and tell Claude what to do differently', run: () => answer(false) },
  ];
  const no = choices.length - 1;
  // Pasting text must never act as an Allow shortcut.
  usePaste(() => {}, { isActive: !asking && !amending });
  useInput((input, key) => {
    if (asking) return;
    if (key.ctrl && input === 'c') { cancel(); return; }
    if (amending) return;
    if (key.escape) { answer(false); return; }
    if (key.upArrow || key.leftArrow || key.shift && key.tab) select(index.current - 1);
    else if (key.downArrow || key.rightArrow) select(index.current + 1);
    else if (key.tab && !approval.local) { select(no); setAmending(true); }
    else if (Date.now() - opened.current < settle) return;
    else if (/^[1-9]$/u.test(input) && Number(input) <= choices.length) choices[Number(input) - 1]!.run();
    else if (input.toLowerCase() === 'y') choices[0]!.run();
    else if (input.toLowerCase() === 'n') choices[no]!.run();
    else if (key.return) choices[index.current]!.run();
  });
  if (asking) return <Rule color="yellow" indent={1}><Question questions={questions} rows={rows} answer={answer} cancel={cancel} /></Rule>;
  const view = request(approval);
  return <Rule color="yellow" indent={1}>
    <Box flexShrink={0}><Text wrap="truncate-end"><Text bold color="yellow">{view.title}</Text><Text dimColor> · {approval.local ? 'Juiced' : 'on Cantelop'}</Text></Text></Box>
    <Clipped>
      {view.body}
      {approval.description && <Text dimColor>{plain(approval.description)}</Text>}
    </Clipped>
    <Box flexShrink={0}><Text wrap="truncate-end">{view.question}</Text></Box>
    {amending
      ? <Prompt editor={feedback} onEdit={setFeedback} placeholder="Tell Claude what to do differently" onEscape={() => setAmending(false)} onSubmit={value => answer(false, undefined, value.trim() ? { message: value.trim() } : {})} />
      : <Box flexShrink={0}><Choices items={choices} index={index.current} rows={choices.length} /></Box>}
    <Box flexShrink={0}><Text dimColor wrap="truncate-end">{amending ? 'Enter to decline with this message · Esc to go back' : `Esc to cancel${approval.local ? '' : ' · Tab to amend'} · Enter to confirm · ↑/↓ to select`}</Text></Box>
  </Rule>;
}

/** Rows of the Ctrl+O transcript: every entry, with complete tool output. */
export function transcriptLines(entries: Entry[]): Row[] {
  const lead = (rows: Row[], first: Span, rest = ' '.repeat(first.text.length)) => rows.map((row, i) => [i ? { text: rest } : first, ...row]);
  const plainRows = (text: string, style: Omit<Span, 'text'> = {}) => text.split('\n').map(line => [{ ...style, text: line }]);
  const result = (text: string, style: Omit<Span, 'text'> = {}) => lead(plainRows(text, style), { text: '  ⎿  ', dim: true }, '     ');
  return entries.flatMap(entry => {
    const open = entry.text.indexOf('(');
    const body = entry.kind === 'user' ? lead(plainRows(entry.text), { text: '❯ ', color: 'green' })
      : entry.kind === 'text' ? lead(markdownRows(entry.text), { text: '● ' })
      : entry.kind === 'tool' ? [
        [{ text: '● ', ...(entry.status === 'failed' ? { color: 'yellow' } : entry.status === 'done' ? { color: 'green' } : { dim: true }) }, { text: open > 0 ? entry.text.slice(0, open) : entry.text, bold: true }, { text: open > 0 ? entry.text.slice(open) : '' }],
        ...result(entry.output ?? entry.detail ?? (entry.status === 'running' ? 'Running…' : '(No content)'), entry.status === 'failed' ? { color: 'yellow' } : {}),
      ]
      : entry.kind === 'summary' ? [[{ text: `✻ ${entry.text}`, dim: true }]] : result(entry.text, { color: 'yellow' });
    return [...body, []];
  });
}

/** Split styled rows to the terminal width so scrolling moves by screen rows. */
export function wrapLines(rows: Row[], width: number): Row[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return rows.flatMap(row => {
    const lines: Row[] = [];
    let line: Row = [], used = 0;
    for (const span of row) {
      let text = '';
      for (const { segment } of segmenter.segment(span.text)) {
        const size = stringWidth(segment);
        if (used + size > width && used) {
          if (text) line.push({ ...span, text });
          lines.push(line); line = []; used = 0; text = '';
        }
        text += segment; used += size;
      }
      if (text) line.push({ ...span, text });
    }
    return [...lines, line];
  });
}

function Transcript({ entries, rows, columns, close }: { entries: Entry[]; rows: number; columns: number; close(): void }) {
  const lines = wrapLines(transcriptLines(entries), Math.max(10, columns - 1));
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

function Juiced({ agent, argv, workspace, rows, columns, quit }: { agent: RemoteAgent; argv: string[]; workspace: string; rows: number; columns: number; quit(code: number, stop?: boolean): void }) {
  const [conversation, setConversation] = useState(emptyConversation);
  const [editor, setEditor] = useDraft();
  const [status, setStatus] = useState<AgentStatus>(agent.status);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>(agent.commands);
  const [menu, setMenu] = useState<{ load(): Promise<MenuPage> }>();
  const menuOpen = useRef(false);
  const [notice, setNotice] = useState('');
  const [closing, setClosing] = useState(false);
  const [help, setHelp] = useState(false);
  const [transcript, setTranscript] = useState(false);
  const refused = useRef(new Set<string>());
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const [pending, setPending] = useState<Pending>();
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const turn = useRef<{ since: number; verb: string }>(undefined);
  const action = (work: Promise<unknown>) => { void work.catch(error => setNotice(plain((error as Error).message))); };
  const exit = () => { if (!closing) { setClosing(true); quit(0); } };
  // A second press within a second confirms, as in Claude Code.
  const arm = (kind: Pending) => {
    clearTimeout(pendingTimer.current);
    setPending(kind);
    pendingTimer.current = setTimeout(() => setPending(undefined), 1000);
  };
  const disarm = () => { clearTimeout(pendingTimer.current); setPending(undefined); };
  useEffect(() => () => clearTimeout(pendingTimer.current), []);
  useEffect(() => {
    const frame = (value: ClaudeFrame) => setConversation(previous => receiveFrame(previous, value));
    const state = (value: AgentStatus) => { setStatus(value); if (value === 'ready') setNotice(''); };
    const permission = () => setApprovals([...agent.approvals.values()]);
    const failure = (error: Error) => { setClosing(true); setNotice(plain(error.message)); quit(1, false); };
    const reconnect = () => setNotice('Reconnecting to the output stream… Your draft is kept locally.');
    const reconnected = () => setNotice('');
    const model = (value: string) => setConversation(previous => ({ ...previous, model: plain(value) }));
    agent.on('frame', frame).on('status', state).on('approvals', permission).on('commands', setCommands).on('model', model).on('failure', failure).on('reconnecting', reconnect).on('reconnected', reconnected);
    // start waits for journal replay. Print its unfinished turn as well as
    // completed turns, so saved output is available in terminal scrollback.
    void agent.start(argv).then(() => setConversation(restoreHistory)).catch(() => {});
    return () => { agent.off('frame', frame).off('status', state).off('approvals', permission).off('commands', setCommands).off('model', model).off('failure', failure).off('reconnecting', reconnect).off('reconnected', reconnected); };
  }, [agent]);
  const busy = ['working', 'interrupting'].includes(status);
  if (!busy) turn.current = undefined;
  else turn.current ??= { since: Date.now(), verb: spinnerVerbs[Math.floor(Math.random() * spinnerVerbs.length)]! };
  const cancel = () => { if (['working', 'interrupting'].includes(agent.status)) action(agent.interrupt()); };
  useInput((input, key) => {
    if (approvals.length || menuOpen.current || transcript) return;
    if (key.ctrl && input === 'o') { setHelp(false); setTranscript(true); return; }
    if (key.ctrl && input === 'c') {
      setHelp(false);
      if (['working', 'interrupting'].includes(agent.status)) cancel();
      else if (editor.current.text) setEditor({ text: '', cursor: 0 });
      else if (pending === 'ctrl-c') exit();
      else arm('ctrl-c');
    }
    if (key.ctrl && input === 'd' && !editor.current.text) {
      if (pending === 'ctrl-d') exit(); else arm('ctrl-d');
    }
  });
  const escape = () => {
    if (['working', 'interrupting'].includes(agent.status)) { cancel(); return; }
    if (!editor.current.text) return;
    if (pending === 'esc') { disarm(); setEditor({ text: '', cursor: 0 }); }
    else arm('esc');
  };
  const cycleMode = () => {
    if (agent.status !== 'ready') { setNotice('Wait for Claude to finish before changing the permission mode.'); return; }
    const current = String(agent.info.current_permission_mode ?? 'default');
    const cycle = [...modeCycle, ...agent.info.launch_permission_mode === 'bypassPermissions' ? ['bypassPermissions'] : []].filter(mode => mode === current || !refused.current.has(mode));
    const after = (mode: string) => cycle[(cycle.indexOf(mode) + 1) % cycle.length]!;
    // Like Claude Code, Shift+Tab changes this session only; /permissions saves a default.
    const apply = (mode: string): Promise<unknown> => agent.configure({ subtype: 'set_permission_mode', mode }, { persist: false }).catch(error => {
      if (!optional.has(mode) || after(mode) === current) throw error;
      refused.current.add(mode);
      return apply(after(mode));
    });
    setNotice('');
    // The mode lives on the agent; repaint once Claude acknowledges it.
    action(apply(after(current)).finally(repaint));
  };
  const submit = (text: string) => {
    if (menuOpen.current) return;
    if (!text.trim()) return;
    if (text.trim() === '/exit' || text.trim() === '/quit') { exit(); return; }
    if (text.trim() === '/detach') { setClosing(true); quit(0, false); return; }
    const modelCommand = /^\/model(?:\s+(.+))?$/u.exec(text.trim());
    if (modelCommand?.[1]) {
      if (agent.status !== 'ready') { setNotice('Wait for Claude to finish before switching models.'); return; }
      const draft = editor.current;
      setEditor({ text: '', cursor: 0 }); setNotice('');
      action(agent.setModel(modelCommand[1]).then(() => setNotice(`Model changed to ${plain(agent.model)}`)).catch(error => { if (!editor.current.text) setEditor(draft); throw error; }));
      return;
    }
    const command = menuCommand(text);
    if (command) {
      if (!['ready', 'working', 'interrupting'].includes(agent.status)) { setNotice('Wait for Claude to connect or finish changing settings.'); return; }
      menuOpen.current = true;
      setMenu({ load: () => commandMenu(agent, command.name, command.argument) });
      setEditor({ text: '', cursor: 0 }); setNotice(''); return;
    }
    if (agent.status !== 'ready') { setNotice('Your draft is local. Wait for Claude to finish, or press Esc to interrupt.'); return; }
    if (Buffer.byteLength(text) > 512 * 1024) { setNotice('The prompt exceeds 512 KiB. Shorten it before sending.'); return; }
    const draft = editor.current;
    setConversation(previous => userTurn(previous, text)); setEditor({ text: '', cursor: 0 }); setNotice('');
    action(agent.submit(text).catch(error => {
      // A local size/buffer rejection has not submitted a turn. Keep it editable.
      if (agent.status === 'ready' && !editor.current.text) {
        setEditor(draft); setConversation(previous => ({ ...previous, live: [] }));
      }
      throw error;
    }));
  };
  const active = approvals[0];
  const live = liveEntries(conversation);
  const history = [...conversation.history.flatMap(item => item.entries), ...conversation.live].filter(entry => entry.kind === 'user').map(entry => entry.text);
  const tokens = turnTokens(conversation);
  const spinner = closing ? 'Disconnecting' : status === 'connecting' ? 'Connecting to Claude' : status === 'configuring' ? 'Updating Claude' : status === 'interrupting' ? 'Interrupting' : status === 'working' ? turn.current?.verb : undefined;
  // Ink can only erase rows still in the viewport. An overflowing live frame
  // pushes its first lines into scrollback again on every option change.
  // Reserve the trailing newline and let layout account for wrapping, borders
  // and the actual height of the controls before clipping conversation rows.
  const height = Math.max(1, rows - 1);
  return <Box flexDirection="column">
    <Static items={[{ id: 'header', entries: [] }, ...conversation.history.map(turn => ({ id: String(turn.id), entries: turn.entries }))]}>{item => item.id === 'header'
      ? <Header key="header" workspace={workspace} session={agent.session.id} />
      : <Entries key={item.id} entries={item.entries} />}</Static>
    {transcript && !active && !menu ? <Transcript entries={[...conversation.history.flatMap(item => item.entries), ...conversation.live]} rows={rows} columns={columns} close={() => setTranscript(false)} /> : <Box flexDirection="column" maxHeight={height} overflow="hidden">
      <Clipped tail><Entries entries={live.slice(-12)} /></Clipped>
      <Box flexDirection="column" flexShrink={0} maxHeight={height} overflow="hidden">
        {spinner && !active && <Box marginBottom={1} flexShrink={0} height={1}><Spinner label={spinner} since={status === 'working' ? turn.current?.since : undefined} tokens={tokens} /></Box>}
        {notice && <Box flexShrink={0} maxHeight={2} overflow="hidden"><Box width={5} flexShrink={0}><Text dimColor>  ⎿ </Text></Box><Text color="yellow">{notice}</Text></Box>}
        {active && <Permission key={active.id} approval={active} rows={rows} cancel={cancel} answer={(allow, answers, options) => action(agent.answer(active.id, allow, answers, options))} />}
        {menu && <Box flexDirection="column" display={active ? 'none' : 'flex'}><CommandMenu load={menu.load} rows={rows} active={!active} cancel={() => { menuOpen.current = false; setMenu(undefined); }} done={result => {
            menuOpen.current = false; setMenu(undefined);
            if ('message' in result) setNotice(plain(result.message));
            else setEditor({ text: result.draft, cursor: result.draft.length });
          }} /></Box>}
        {!active && !menu && <>
          <Prompt editor={editor} onEdit={setEditor} onSubmit={submit} onEscape={escape} onCycleMode={cycleMode} onHelp={() => setHelp(value => !value)} onKey={() => { if (help) setHelp(false); }} commands={availableCommands(commands)} history={history} menuRows={Math.max(1, Math.min(5, rows - 12))} disabled={closing} />
          {help ? <Shortcuts /> : <Footer mode={String(agent.info.current_permission_mode ?? 'default')} pending={pending} busy={busy} empty={!editor.current.text} model={conversation.model} />}
        </>}
      </Box>
    </Box>}
  </Box>;
}

export async function runLocalTui(agent: RemoteAgent, argv: string[], workspace: string, io: TerminalIO, signal: AbortSignal): Promise<number> {
  let code = 0;
  let quitting: Promise<void> | undefined;
  const quit = (nextCode: number, stop = true) => {
    code = Math.max(code, nextCode);
    quitting ??= agent.close(stop).catch(error => { code = 1; io.stderr.write(`juiced: ${plain((error as Error).message)}\n`); }).finally(() => instance.unmount());
  };
  const ui = () => <Juiced agent={agent} argv={argv} workspace={workspace} rows={io.stdout.rows || 24} columns={io.stdout.columns || 80} quit={quit} />;
  const instance = render(ui(), { stdin: io.stdin as NodeJS.ReadStream, stdout: io.stdout as NodeJS.WriteStream, stderr: io.stderr as NodeJS.WriteStream, exitOnCtrlC: false, interactive: true });
  // Update the row budget before Ink's synchronous resize repaint, which would
  // otherwise paint one frame using the old height in the smaller terminal.
  const resize = () => instance.rerender(ui());
  io.stdout.prependListener('resize', resize);
  const abort = () => quit(0, false);
  const ioError = (error: Error) => { io.stderr.write(`juiced: ${plain(error.message)}\n`); quit(1, false); };
  signal.addEventListener('abort', abort, { once: true });
  io.stdin.once('end', abort);
  io.stdin.once('error', ioError);
  io.stdout.once('error', ioError);
  if (signal.aborted) abort();
  try { await instance.waitUntilExit(); await quitting; return code; }
  finally { signal.removeEventListener('abort', abort); io.stdin.off('end', abort); io.stdin.off('error', ioError); io.stdout.off('error', ioError); io.stdout.off('resize', resize); await agent.close().catch(() => {}); }
}
