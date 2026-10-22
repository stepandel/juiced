import React, { useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { object, type Approval, type ApprovalOptions, type ClaudeFrame } from '../agent-protocol.js';
import { plain, toolSummary } from './conversation.js';
import { Clipped, modes, Rule } from './chrome.js';
import { Prompt, useDraft } from './prompt.js';

const dashes = { topLeft: '', top: '╌', topRight: '', left: '', right: '', bottomLeft: '', bottom: '╌', bottomRight: '' };
const lines = (value: unknown) => plain(value).replace(/\n+$/u, '').split('\n');
const path = (value: unknown) => plain(value).replace(/^\/workspace\//u, '');
/** Claude Code's per-tool permission titles, questions and previews. */
function request(approval: Approval): { title: string; question: string; body: React.ReactNode } {
  const input = approval.input;
  const dashed = (children: React.ReactNode) => <Box flexDirection="column" borderStyle={dashes} borderLeft={false} borderRight={false} borderDimColor>{children}</Box>;
  const json = plain(JSON.stringify(input, null, 2));
  const raw = <Text>{json.length > 12_000 ? json.slice(0, 12_000) + '\n[preview truncated]' : json}</Text>;
  if (approval.upload) return { title: 'Send local changes to the remote workspace', question: 'Send this snapshot from your laptop to the remote workspace?', body: raw };
  if (approval.local) return { title: 'Apply to your local checkout', question: 'Do you want to apply these changes in your local checkout?', body: raw };
  if (approval.tool === 'Bash') return { title: 'Bash command', question: 'Do you want to proceed?', body: <Box flexDirection="column" paddingLeft={2}>
    <Text>{plain(input.command)}</Text>
    {input.description ? <Text dimColor>{plain(input.description)}</Text> : null}
  </Box> };
  // Write can create or replace a remote file; the request does not say which.
  if (approval.tool === 'Write') return { title: 'Write file', question: `Do you want to write ${path(input.file_path)}?`, body: <>
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

export function Permission({ approval, rows, answer, cancel }: { approval: Approval; rows: number; answer(allow: boolean, answers?: Record<string, string>, options?: ApprovalOptions): void; cancel(): void }) {
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
