import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, Static, render, useInput } from 'ink';
import type { Approval, ClaudeFrame, SlashCommand } from '../agent-protocol.js';
import { RemoteAgent, type AgentStatus } from '../remote-agent.js';
import type { TerminalIO } from '../remote-terminal.js';
import { emptyConversation, liveEntries, plain, receiveFrame, restoreHistory, turnTokens, userTurn, type Entry } from './conversation.js';
import { Entries, Header } from './transcript.js';
import { availableCommands } from './commands.js';
import { CommandMenu, type MenuPage } from './menu.js';
import { commandMenu, menuCommand } from './command-menus.js';
import { Clipped, Footer, modeCycle, optional, Shortcuts, Spinner, spinnerVerbs, type Pending } from './chrome.js';
import { Prompt, useDraft } from './prompt.js';
import { Permission } from './permission.js';
import { Transcript } from './transcript-view.js';

function Juiced({ agent, argv, workspace, rows, columns, reflow, quit }: { agent: RemoteAgent; argv: string[]; workspace: string; rows: number; columns: number; reflow: number; quit(code: number, stop?: boolean): void }) {
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
  const live = useMemo(() => liveEntries(conversation), [conversation.live, conversation.printed]);
  const entries = useMemo(() => [...conversation.history.flatMap(item => item.entries), ...conversation.live], [conversation.history, conversation.live]);
  const history = useMemo(() => entries.filter(entry => entry.kind === 'user').map(entry => entry.text), [entries]);
  const scrollback = useMemo(() => [{ id: 'header', entries: [] as Entry[] }, ...conversation.history.map(turn => ({ id: String(turn.id), entries: turn.entries }))], [conversation.history]);
  const tokens = turnTokens(conversation);
  const spinner = closing ? 'Disconnecting' : status === 'connecting' ? 'Connecting to Claude' : status === 'configuring' ? 'Updating Claude' : status === 'interrupting' ? 'Interrupting' : status === 'working' ? turn.current?.verb : undefined;
  // Ink can only erase rows still in the viewport. An overflowing live frame
  // pushes its first lines into scrollback again on every option change.
  // Reserve the trailing newline and let layout account for wrapping, borders
  // and the actual height of the controls before clipping conversation rows.
  const height = Math.max(1, rows - 1);
  return <Box flexDirection="column">
    <Static key={reflow} items={scrollback}>{item => item.id === 'header'
      ? <Header key="header" workspace={workspace} session={agent.session.id} />
      : <Entries key={item.id} entries={item.entries} />}</Static>
    {transcript && !active && !menu ? <Transcript entries={entries} rows={rows} columns={columns} close={() => setTranscript(false)} /> : <Box flexDirection="column" maxHeight={height} overflow="hidden">
      <Clipped tail><Entries entries={live.slice(-12)} tail={height} /></Clipped>
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
  let reflow = 0, width = io.stdout.columns || 80, reflowTimer: NodeJS.Timeout | undefined;
  const ui = () => <Juiced agent={agent} argv={argv} workspace={workspace} rows={io.stdout.rows || 24} columns={io.stdout.columns || 80} reflow={reflow} quit={quit} />;
  const instance = render(ui(), { stdin: io.stdin as NodeJS.ReadStream, stdout: io.stdout as NodeJS.WriteStream, stderr: io.stderr as NodeJS.WriteStream, exitOnCtrlC: false, interactive: true });
  // Finished turns sit in scrollback at the width they were printed with, so
  // a narrower terminal hard-wraps them mid-word. Like Claude Code, once the
  // width settles, clear the screen and scrollback and print them again.
  const reprint = () => {
    if ((io.stdout.columns || 80) === width) return;
    width = io.stdout.columns || 80; reflow++;
    instance.clear(); io.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    instance.rerender(ui());
  };
  // Update the row budget before Ink's synchronous resize repaint, which would
  // otherwise paint one frame using the old height in the smaller terminal.
  const resize = () => { instance.rerender(ui()); clearTimeout(reflowTimer); reflowTimer = setTimeout(reprint, 50); };
  io.stdout.prependListener('resize', resize);
  const abort = () => quit(0, false);
  const ioError = (error: Error) => { io.stderr.write(`juiced: ${plain(error.message)}\n`); quit(1, false); };
  signal.addEventListener('abort', abort, { once: true });
  io.stdin.once('end', abort);
  io.stdin.once('error', ioError);
  io.stdout.once('error', ioError);
  if (signal.aborted) abort();
  try { await instance.waitUntilExit(); await quitting; return code; }
  finally { clearTimeout(reflowTimer); signal.removeEventListener('abort', abort); io.stdin.off('end', abort); io.stdin.off('error', ioError); io.stdout.off('error', ioError); io.stdout.off('resize', resize); await agent.close().catch(() => {}); }
}
