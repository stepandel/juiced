import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, Static, render, useInput, usePaste } from 'ink';
import { object, type Approval, type ClaudeFrame, type SlashCommand } from '../agent-protocol.js';
import { RemoteAgent, type AgentStatus } from '../remote-agent.js';
import type { TerminalIO } from '../remote-terminal.js';
import { cursorParts, edit, type Editor } from './editor.js';
import { emptyConversation, liveEntries, plain, receiveFrame, receiveSnapshot, restoreHistory, userTurn, type Conversation, type Entry } from './conversation.js';
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

function Entries({ entries }: { entries: Entry[] }) {
  return <Box flexDirection="column">{entries.map(entry => <Box key={entry.id} marginBottom={entry.kind === 'tool' ? 0 : 1}>
    <Box width={2}><Text color={entry.kind === 'user' ? 'green' : entry.kind === 'notice' || entry.status === 'failed' ? 'yellow' : 'cyan'}>{entry.kind === 'user' ? '›' : entry.kind === 'tool' ? entry.status === 'running' ? '○' : entry.status === 'failed' ? '!' : '✓' : entry.kind === 'notice' ? '!' : '●'}</Text></Box>
    <Box flexGrow={1}><Text dimColor={entry.kind === 'tool'}>{entry.text}</Text></Box>
  </Box>)}</Box>;
}

function Clipped({ children, tail = false }: { children: React.ReactNode; tail?: boolean }) {
  return <Box flexDirection="column" overflow="hidden" justifyContent={tail ? 'flex-end' : 'flex-start'}>
    <Box flexDirection="column" flexShrink={0}>{children}</Box>
  </Box>;
}

function Prompt({ editor, onEdit, onSubmit, onEscape, commands, menuRows = 6, disabled = false, placeholder = 'Ask Claude to work in your remote workspace…' }: { editor: Draft; onEdit(value: Editor): void; onSubmit(value: string): void; onEscape?(): void; commands?: SlashCommand[]; menuRows?: number; disabled?: boolean; placeholder?: string }) {
  const menu = useRef({ query: '', index: 0, dismissed: false });
  const [, refreshMenu] = useReducer((value: number) => value + 1, 0);
  // Read the current draft for every key, including rapid arrow + Enter input.
  const suggestions = () => {
    const matches = disabled || !commands ? [] : matchingCommands(editor.current, commands);
    const query = matches.length ? editor.current.text : '';
    if (menu.current.query !== query) menu.current = { query, index: 0, dismissed: false };
    menu.current.index = Math.min(menu.current.index, Math.max(0, matches.length - 1));
    return menu.current.dismissed ? [] : matches;
  };
  usePaste(text => onEdit(edit(editor.current, text, {})), { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && ['c', 'd'].includes(input)) return;
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
    const selected = matches[menu.current.index];
    if (selected && key.tab) {
      const text = `/${selected.name} `;
      onEdit({ text, cursor: text.length }); return;
    }
    if (key.return && !key.meta && !key.shift) {
      if (editor.current.text.endsWith('\\')) { onEdit({ text: editor.current.text.slice(0, -1) + '\n', cursor: editor.current.text.length }); return; }
      onSubmit(selected ? `/${selected.name}` : editor.current.text); return;
    }
    onEdit(edit(editor.current, input, key));
  }, { isActive: !disabled });
  const [before, cursor, after] = cursorParts(editor.current);
  const matches = suggestions();
  const start = Math.max(0, menu.current.index - menuRows + 1);
  return <Box flexDirection="column">
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'green'} paddingX={1}>
      <Text color="green">› </Text>
      <Box flexGrow={1}><Clipped tail><Text>{editor.current.text ? <>{before}<Text inverse={!disabled}>{cursor}</Text>{after}</> : <><Text inverse={!disabled}> </Text><Text dimColor>{placeholder}</Text></>}</Text></Clipped></Box>
    </Box>
    {matches.length > 0 && <Box flexDirection="column" flexShrink={0}>
      {matches.slice(start, start + menuRows).map((command, i) => <Box key={command.name} height={1} paddingX={1}>
        <Text wrap="truncate-end" inverse={start + i === menu.current.index}>{start + i === menu.current.index ? '›' : ' '} /{command.name}{command.argumentHint ? ` ${plain(command.argumentHint).replace(/\s+/g, ' ')}` : ''}{command.description ? `  ${plain(command.description).replace(/\s+/g, ' ')}` : ''}</Text>
      </Box>)}
      <Box height={1} paddingX={1}><Text dimColor wrap="truncate-end">{menu.current.index + 1}/{matches.length} · ↑/↓ select · Tab complete · Enter run · Esc close</Text></Box>
    </Box>}
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
  return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} overflow="hidden">
    <Box flexShrink={0}><Text bold color="yellow">{asking ? 'Claude has a question' : `Allow ${plain(approval.tool)} on Cantelop?`}</Text></Box>
    {asking ? <>
      <Clipped>
        <Text>{plain(question.question)}</Text>
        {Array.isArray(question.options) && question.options.map((raw, i) => { const option = object(raw); return <Text key={i} dimColor>{i + 1}. {plain(option.label)}{option.description ? ` — ${plain(option.description)}` : ''}</Text>; })}
      </Clipped>
      <Prompt editor={editor} onEdit={setEditor} placeholder="Type an answer or option number" onSubmit={value => {
        if (!value.trim()) return;
        const options = Array.isArray(question.options) ? question.options.map(object) : [];
        const choice = options[Number(value) - 1];
        const next = { ...answers, [String(question.question)]: choice ? String(choice.label) : value };
        if (index + 1 === questions.length) answer(true, next);
        else { setAnswers(next); setIndex(index + 1); setEditor({ text: '', cursor: 0 }); }
      }} />
    </> : <>
      <Clipped>
        <Text>{preview.length > 12_000 ? preview.slice(0, 12_000) + '\n[preview truncated]' : preview}</Text>
        {approval.description && <Text dimColor>{plain(approval.description)}</Text>}
      </Clipped>
      <Box flexShrink={0}><Text><Text inverse={!selected.current}> Deny </Text>{'  '}<Text inverse={selected.current}> Allow once </Text>{'  '}<Text dimColor>←/→ select · Enter confirm · y/n</Text></Text></Box>
    </>}
  </Box>;
}

function Juiced({ agent, argv, workspace, rows, quit }: { agent: RemoteAgent; argv: string[]; workspace: string; rows: number; quit(code: number, stop?: boolean): void }) {
  const [conversation, setConversation] = useState(emptyConversation);
  const [editor, setEditor] = useDraft();
  const [status, setStatus] = useState<AgentStatus>(agent.status);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>(agent.commands);
  const [menu, setMenu] = useState<{ load(): Promise<MenuPage> }>();
  const menuOpen = useRef(false);
  const [notice, setNotice] = useState('');
  const [closing, setClosing] = useState(false);
  const action = (work: Promise<unknown>) => { void work.catch(error => setNotice(plain((error as Error).message))); };
  const exit = () => { if (!closing) { setClosing(true); quit(0); } };
  useEffect(() => {
    const frame = (value: ClaudeFrame) => setConversation(previous => receiveFrame(previous, value));
    const snapshot = (value: Conversation) => setConversation(previous => receiveSnapshot(previous, value));
    const state = (value: AgentStatus) => { setStatus(value); if (value === 'ready') setNotice(''); };
    const permission = () => setApprovals([...agent.approvals.values()]);
    const failure = (error: Error) => { setClosing(true); setNotice(plain(error.message)); quit(1, false); };
    const reconnect = () => setNotice('Reconnecting to the output stream… Your draft is kept locally.');
    const reconnected = () => setNotice('');
    const model = (value: string) => setConversation(previous => ({ ...previous, model: plain(value) }));
    agent.on('frame', frame).on('snapshot', snapshot).on('status', state).on('approvals', permission).on('commands', setCommands).on('model', model).on('failure', failure).on('reconnecting', reconnect).on('reconnected', reconnected);
    // Print the restored current display once; new output continues below it.
    void agent.start(argv).then(() => setConversation(restoreHistory)).catch(() => {});
    return () => { agent.off('frame', frame).off('snapshot', snapshot).off('status', state).off('approvals', permission).off('commands', setCommands).off('model', model).off('failure', failure).off('reconnecting', reconnect).off('reconnected', reconnected); };
  }, [agent]);
  const cancel = () => { if (['working', 'interrupting'].includes(agent.status)) action(agent.interrupt()); };
  useInput((input, key) => {
    if (approvals.length || menuOpen.current) return;
    if (key.ctrl && input === 'c') {
      if (['working', 'interrupting'].includes(agent.status)) cancel();
      else if (editor.current.text) setEditor({ text: '', cursor: 0 });
      else exit();
    }
    if (key.ctrl && input === 'd' && !editor.current.text) exit();
  });
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
      if (command.name === 'model' && !agent.models.length) { setNotice('Claude did not provide a model list. Use /model <name> to choose a model.'); return; }
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
  // Ink can only erase rows still in the viewport. An overflowing live frame
  // pushes its first lines into scrollback again on every option change.
  // Reserve the trailing newline and let layout account for wrapping, borders
  // and the actual height of the controls before clipping conversation rows.
  const height = Math.max(1, rows - 1);
  return <Box flexDirection="column">
    <Static items={[{ id: 'header', entries: [] }, ...conversation.history.map(turn => ({ id: String(turn.id), entries: turn.entries }))]}>{item => item.id === 'header'
      ? <Box key="header" flexDirection="column" marginBottom={1}><Text bold color="green">JUICED</Text><Text dimColor>Claude on Cantelop · workspace {workspace} · local keyboard and interface</Text><Text dimColor>Session {agent.session.id} · reattach with juiced --resume claude</Text></Box>
      : <Entries key={item.id} entries={item.entries} />}</Static>
    <Box flexDirection="column" maxHeight={height} overflow="hidden">
      <Clipped tail><Entries entries={liveEntries(conversation).slice(-12)} /></Clipped>
      <Box flexDirection="column" flexShrink={0} maxHeight={height} overflow="hidden">
        <Box marginBottom={1} flexShrink={0} maxHeight={2} overflow="hidden"><Text color={status === 'ready' ? 'green' : status === 'failed' ? 'red' : 'cyan'}>{closing ? 'Disconnecting…' : status === 'connecting' ? 'Connecting to Claude…' : status === 'working' ? 'Claude is working…' : status === 'configuring' ? 'Updating Claude…' : status === 'interrupting' ? 'Interrupting…' : status === 'ready' ? 'Ready' : status}</Text><Text dimColor>{conversation.model ? ` · ${conversation.model}` : ''}{conversation.tokens ? ` · ${conversation.tokens.toLocaleString()} tokens last turn` : ''}</Text></Box>
        {notice && <Box marginBottom={1} flexShrink={0} maxHeight={2} overflow="hidden"><Text color="yellow">{notice}</Text></Box>}
        {active && <Permission key={active.id} approval={active} cancel={cancel} answer={(allow, answers) => action(agent.answer(active.id, allow, answers))} />}
        {menu && <Box flexDirection="column" display={active ? 'none' : 'flex'}><CommandMenu load={menu.load} rows={rows} active={!active} cancel={() => { menuOpen.current = false; setMenu(undefined); }} done={result => {
            menuOpen.current = false; setMenu(undefined);
            if ('message' in result) setNotice(plain(result.message));
            else setEditor({ text: result.draft, cursor: result.draft.length });
          }} /></Box>}
        {!active && !menu && <Prompt editor={editor} onEdit={setEditor} onSubmit={submit} onEscape={cancel} commands={availableCommands(commands)} menuRows={Math.max(1, Math.min(6, rows - 12))} disabled={closing} />}
        <Box flexShrink={0}><Text dimColor wrap="truncate-end">{active ? 'Esc decline · Ctrl+C interrupt' : menu ? '↑/↓ select · Enter confirm · Esc cancel' : 'Enter send · Alt+Enter newline · Esc interrupt · Ctrl+C clear / exit · / commands'}</Text></Box>
      </Box>
    </Box>
  </Box>;
}

export async function runLocalTui(agent: RemoteAgent, argv: string[], workspace: string, io: TerminalIO, signal: AbortSignal): Promise<number> {
  let code = 0;
  let quitting: Promise<void> | undefined;
  const quit = (nextCode: number, stop = true) => {
    code = Math.max(code, nextCode);
    quitting ??= agent.close(stop).catch(error => { code = 1; io.stderr.write(`juiced: ${plain((error as Error).message)}\n`); }).finally(() => instance.unmount());
  };
  const ui = () => <Juiced agent={agent} argv={argv} workspace={workspace} rows={io.stdout.rows || 24} quit={quit} />;
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
