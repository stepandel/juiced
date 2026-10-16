import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, Static, render, useInput, usePaste, useStdout } from 'ink';
import { object, type Approval, type ClaudeFrame } from '../agent-protocol.js';
import { RemoteAgent, type AgentStatus } from '../remote-agent.js';
import type { TerminalIO } from '../remote-terminal.js';
import { cursorParts, edit, type Editor } from './editor.js';
import { emptyConversation, plain, receiveFrame, userTurn, type Entry } from './conversation.js';

type Draft = { current: Editor };
function useDraft(): [Draft, (next: Editor) => void] {
  const current = useRef<Editor>({ text: '', cursor: 0 });
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  // Multiple key events can arrive before React commits a render. Keep their
  // edits synchronous so rapid typing never reads an earlier cursor or draft.
  return [current, next => { current.current = next; refresh(); }];
}

function Entries({ entries }: { entries: Entry[] }) {
  return <Box flexDirection="column">{entries.map(entry => <Box key={entry.id} marginBottom={entry.kind === 'tool' ? 0 : 1}>
    <Box width={2}><Text color={entry.kind === 'user' ? 'green' : entry.kind === 'notice' || entry.status === 'failed' ? 'yellow' : 'cyan'}>{entry.kind === 'user' ? '›' : entry.kind === 'tool' ? entry.status === 'running' ? '○' : entry.status === 'failed' ? '!' : '✓' : entry.kind === 'notice' ? '!' : '●'}</Text></Box>
    <Box flexGrow={1}><Text dimColor={entry.kind === 'tool'}>{entry.text}</Text></Box>
  </Box>)}</Box>;
}

function Prompt({ editor, onEdit, onSubmit, disabled = false, placeholder = 'Ask Claude to work in your remote workspace…' }: { editor: Draft; onEdit(value: Editor): void; onSubmit(value: string): void; disabled?: boolean; placeholder?: string }) {
  usePaste(text => onEdit(edit(editor.current, text, {})), { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && ['c', 'd'].includes(input) || key.escape) return;
    if (key.return && !key.meta && !key.shift) {
      if (editor.current.text.endsWith('\\')) { onEdit({ text: editor.current.text.slice(0, -1) + '\n', cursor: editor.current.text.length }); return; }
      onSubmit(editor.current.text); return;
    }
    onEdit(edit(editor.current, input, key));
  }, { isActive: !disabled });
  const [before, cursor, after] = cursorParts(editor.current);
  return <Box borderStyle="round" borderColor={disabled ? 'gray' : 'green'} paddingX={1}>
    <Text color="green">› </Text>
    <Box flexGrow={1}><Text>{editor.current.text ? <>{before}<Text inverse={!disabled}>{cursor}</Text>{after}</> : <><Text inverse={!disabled}> </Text><Text dimColor>{placeholder}</Text></>}</Text></Box>
  </Box>;
}

function Permission({ approval, answer, cancel }: { approval: Approval; answer(allow: boolean, answers?: Record<string, string>): void; cancel(): void }) {
  const selected = useRef(false);
  const [, refreshSelection] = useReducer((value: number) => value + 1, 0);
  const [editor, setEditor] = useDraft();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const questions = Array.isArray(approval.input.questions) ? approval.input.questions.map(object) : [];
  const question = questions[index];
  const asking = approval.tool === 'AskUserQuestion' && question !== undefined;
  // Pasting text must never act as an Allow shortcut.
  usePaste(() => {}, { isActive: !asking });
  useInput((input, key) => {
    if (key.escape) { answer(false); return; }
    if (key.ctrl && input === 'c') { cancel(); return; }
    if (asking) return;
    if (key.leftArrow || key.rightArrow || key.tab) { selected.current = !selected.current; refreshSelection(); }
    else if (input.toLowerCase() === 'y') answer(true);
    else if (input.toLowerCase() === 'n') answer(false);
    else if (key.return) answer(selected.current);
  });
  const preview = plain(JSON.stringify(approval.input, null, 2));
  return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
    <Text bold color="yellow">{asking ? 'Claude has a question' : `Allow ${plain(approval.tool)} on Cantelop?`}</Text>
    {asking ? <>
      <Text>{plain(question.question)}</Text>
      {Array.isArray(question.options) && question.options.map((raw, i) => { const option = object(raw); return <Text key={i} dimColor>{i + 1}. {plain(option.label)}{option.description ? ` — ${plain(option.description)}` : ''}</Text>; })}
      <Prompt editor={editor} onEdit={setEditor} placeholder="Type an answer or option number" onSubmit={value => {
        if (!value.trim()) return;
        const options = Array.isArray(question.options) ? question.options.map(object) : [];
        const choice = options[Number(value) - 1];
        const next = { ...answers, [String(question.question)]: choice ? String(choice.label) : value };
        if (index + 1 === questions.length) answer(true, next);
        else { setAnswers(next); setIndex(index + 1); setEditor({ text: '', cursor: 0 }); }
      }} />
    </> : <>
      <Text>{preview.length > 12_000 ? preview.slice(0, 12_000) + '\n[preview truncated]' : preview}</Text>
      {approval.description && <Text dimColor>{plain(approval.description)}</Text>}
      <Text><Text inverse={!selected.current}> Deny </Text>{'  '}<Text inverse={selected.current}> Allow once </Text>{'  '}<Text dimColor>←/→ select · Enter confirm · y/n</Text></Text>
    </>}
  </Box>;
}

function Juiced({ agent, argv, workspace, quit }: { agent: RemoteAgent; argv: string[]; workspace: string; quit(code: number): void }) {
  const [conversation, setConversation] = useState(emptyConversation);
  const [editor, setEditor] = useDraft();
  const [status, setStatus] = useState<AgentStatus>(agent.status);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notice, setNotice] = useState('');
  const [closing, setClosing] = useState(false);
  const { stdout } = useStdout();
  const action = (work: Promise<unknown>) => { void work.catch(error => setNotice(plain((error as Error).message))); };
  const exit = () => { if (!closing) { setClosing(true); quit(0); } };
  useEffect(() => {
    const frame = (value: ClaudeFrame) => setConversation(previous => receiveFrame(previous, value));
    const state = (value: AgentStatus) => { setStatus(value); if (value === 'ready') setNotice(''); };
    const permission = () => setApprovals([...agent.approvals.values()]);
    const failure = (error: Error) => { setClosing(true); setNotice(plain(error.message)); quit(1); };
    const reconnect = () => setNotice('Reconnecting to the output stream… Your draft is kept locally.');
    agent.on('frame', frame).on('status', state).on('approvals', permission).on('failure', failure).on('reconnecting', reconnect);
    void agent.start(argv).catch(() => {});
    return () => { agent.off('frame', frame).off('status', state).off('approvals', permission).off('failure', failure).off('reconnecting', reconnect); };
  }, [agent]);
  const cancel = () => { if (['working', 'interrupting'].includes(agent.status)) action(agent.interrupt()); };
  useInput((input, key) => {
    if (approvals.length) return;
    if (key.escape) cancel();
    if (key.ctrl && input === 'c') {
      if (['working', 'interrupting'].includes(agent.status)) cancel();
      else if (editor.current.text) setEditor({ text: '', cursor: 0 });
      else exit();
    }
    if (key.ctrl && input === 'd' && !editor.current.text) exit();
  });
  const submit = (text: string) => {
    if (!text.trim()) return;
    if (text.trim() === '/exit' || text.trim() === '/quit') { exit(); return; }
    if (text.trim() === '/help') { setNotice('Enter sends · Alt+Enter or \\ then Enter adds a line · Esc interrupts · /exit quits. Claude flags such as --model apply at launch.'); setEditor({ text: '', cursor: 0 }); return; }
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
  const live = conversation.live.slice(-12).map(entry => ({ ...entry, text: entry.text.split('\n').slice(-Math.max(4, ((stdout as NodeJS.WriteStream).rows ?? 24) - 12)).join('\n') }));
  return <Box flexDirection="column">
    <Static items={[{ id: 'header', entries: [] }, ...conversation.history.map(turn => ({ id: String(turn.id), entries: turn.entries }))]}>{item => item.id === 'header'
      ? <Box key="header" flexDirection="column" marginBottom={1}><Text bold color="green">JUICED</Text><Text dimColor>Claude on Cantelop · workspace {workspace} · local keyboard and interface</Text></Box>
      : <Entries key={item.id} entries={item.entries} />}</Static>
    <Entries entries={live} />
    <Box marginBottom={1}><Text color={status === 'ready' ? 'green' : status === 'failed' ? 'red' : 'cyan'}>{closing ? 'Disconnecting…' : status === 'connecting' ? 'Connecting to Claude…' : status === 'working' ? 'Claude is working…' : status === 'interrupting' ? 'Interrupting…' : status === 'ready' ? 'Ready' : status}</Text><Text dimColor>{conversation.model ? ` · ${conversation.model}` : ''}{conversation.tokens ? ` · ${conversation.tokens.toLocaleString()} tokens last turn` : ''}</Text></Box>
    {notice && <Box marginBottom={1}><Text color="yellow">{notice}</Text></Box>}
    {active ? <Permission key={active.id} approval={active} cancel={cancel} answer={(allow, answers) => action(agent.answer(active.id, allow, answers))} />
      : <Prompt editor={editor} onEdit={setEditor} onSubmit={submit} disabled={closing} />}
    <Text dimColor>{active ? 'Esc decline · Ctrl+C interrupt' : 'Enter send · Alt+Enter newline · Esc interrupt · Ctrl+C clear / exit · /help'}</Text>
  </Box>;
}

export async function runLocalTui(agent: RemoteAgent, argv: string[], workspace: string, io: TerminalIO, signal: AbortSignal): Promise<number> {
  let code = 0;
  let quitting: Promise<void> | undefined;
  const quit = (nextCode: number) => {
    code = Math.max(code, nextCode);
    quitting ??= agent.close().catch(error => { code = 1; io.stderr.write(`juiced: ${plain((error as Error).message)}\n`); }).finally(() => instance.unmount());
  };
  const instance = render(<Juiced agent={agent} argv={argv} workspace={workspace} quit={quit} />, { stdin: io.stdin as NodeJS.ReadStream, stdout: io.stdout as NodeJS.WriteStream, stderr: io.stderr as NodeJS.WriteStream, exitOnCtrlC: false, interactive: true });
  const abort = () => quit(0);
  const ioError = (error: Error) => { io.stderr.write(`juiced: ${plain(error.message)}\n`); quit(1); };
  signal.addEventListener('abort', abort, { once: true });
  io.stdin.once('end', abort);
  io.stdin.once('error', ioError);
  io.stdout.once('error', ioError);
  if (signal.aborted) abort();
  try { await instance.waitUntilExit(); await quitting; return code; }
  finally { signal.removeEventListener('abort', abort); io.stdin.off('end', abort); io.stdin.off('error', ioError); io.stdout.off('error', ioError); await agent.close().catch(() => {}); }
}
