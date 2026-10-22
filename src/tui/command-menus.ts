import { object, type ClaudeFrame, type MenuChange, type MenuQuery, type SlashCommand } from '../agent-protocol.js';
import { unsupportedControl as unsupported, type RemoteAgent } from '../remote-agent.js';
import type { MenuItem, MenuPage, MenuResult } from './menu.js';

export const menuCommands: SlashCommand[] = [
  ['config', 'Browse workspace settings', '[key=value]'], ['settings', 'Browse workspace settings', '[key=value]'],
  ['effort', 'Choose default model effort', '[level]'], ['fast', 'Manage default fast mode', '[on|off]'],
  ['output-style', 'Choose a default output style', '[name]'],
  ['permissions', 'Choose permission mode and inspect configured rules', ''], ['mcp', 'Manage connected MCP servers', ''],
  ['hooks', 'Inspect configured hooks', ''], ['tasks', 'Inspect and stop background tasks', ''],
  ['agents', 'Browse available agents', ''], ['skills', 'Browse available skills and commands', ''],
  ['plugin', 'Inspect configured plugins and reload them', ''], ['plugins', 'Inspect configured plugins and reload them', ''],
  ['context', 'Inspect current context usage', ''], ['memory', 'Browse loaded memory files', ''],
  ['usage', 'Inspect session cost and plan usage', ''], ['cost', 'Inspect session cost and plan usage', ''], ['stats', 'Inspect session cost and plan usage', ''],
  ['status', 'Inspect the remote session', ''], ['rename', 'Rename this conversation', '[name]'], ['name', 'Rename this conversation', '[name]'],
  ['reload-plugins', 'Reload plugins in this session', ''], ['reload-skills', 'Reload skills in this session', ''],
].map(([name, description, argumentHint]) => ({ name: name!, description: description!, argumentHint: argumentHint! }));

// These screens have no equivalent in the pinned headless protocol. Recognize
// them even though initialize omits them, rather than submitting an LLM prompt.
const unavailable: Record<string, string> = {
  resume: 'List saved Juiced conversations with juiced claude sessions, then reopen one with juiced claude --session <session-id>. Run juiced claude in the original terminal tab to reconnect to its session.',
  rewind: 'Claude does not expose conversation checkpoints over the headless protocol. File rewind alone would not restore the conversation.',
  checkpoint: 'Claude does not expose conversation checkpoints over the headless protocol.',
  theme: 'Claude’s terminal themes apply to its native renderer. Juiced uses your terminal colors and its own local renderer.',
  'terminal-setup': 'This command configures Claude’s native terminal renderer. Juiced handles terminal input locally.',
  keybindings: 'Claude’s keybinding editor controls its native renderer. Juiced uses the shortcuts listed in /help.',
  vim: 'Juiced’s local editor does not currently implement Vim keybindings.',
  login: 'Sign in before starting the session with juiced claude login.',
  logout: 'An active Juiced session cannot change the remote account. Exit before changing authentication.',
  'add-dir': 'Add working directories when launching Claude with --add-dir <directory>. The pinned protocol cannot open the native directory picker.',
  export: 'Claude does not expose its export picker over the headless protocol.',
  feedback: 'Claude does not expose its feedback dialog over the headless protocol.',
  bug: 'Claude does not expose its feedback dialog over the headless protocol.',
  'remote-control': 'This session already uses Juiced’s remote connection. Claude’s native Remote Control dialog is not exposed over this protocol.',
};

const aliases: Record<string, string> = { settings: 'config', plugins: 'plugin', cost: 'usage', stats: 'usage', name: 'rename' };
export function menuCommand(text: string): { name: string; argument: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return;
  const name = Object.hasOwn(aliases, match[1]!) ? aliases[match[1]!]! : match[1]!;
  if (['model', 'help', ...menuCommands.map(command => command.name)].includes(name) || Object.hasOwn(unavailable, name)) return { name, argument: match[2]?.trim() ?? '' };
  return undefined;
}

const records = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const str = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const message = (text: string): MenuResult => ({ message: text });

function safe(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => /env|secret|password|credential|authorization|headers?|api.?key|access.?token|refresh.?token/iu.test(key) ? '[redacted]' : item, 2) ?? String(value);
}
function inspect(title: string, value: unknown, back?: MenuPage['back']): MenuPage {
  const text = typeof value === 'string' ? value : safe(value);
  const lines = text.split('\n').flatMap(line => line.match(/.{1,76}/gu) ?? ['']);
  return { title, items: lines.map((line, index) => ({ id: String(index), label: line || ' ', description: line })), ...(back ? { back } : {}) };
}
function confirm(title: string, description: string, back: () => MenuPage | Promise<MenuPage>, change: () => Promise<MenuResult>): MenuPage {
  return { title, description, search: false, back, items: [
    { id: 'cancel', label: 'Cancel', run: back },
    { id: 'confirm', label: 'Confirm', run: change },
  ] };
}

/** Command adapters consume remote catalogs; none scrape a native terminal. */
export async function commandMenu(agent: RemoteAgent, name: string, argument = '', snapshots = new Map<string, Promise<ClaudeFrame>>()): Promise<MenuPage> {
  name = Object.hasOwn(aliases, name) ? aliases[name]! : name;
  const open = (command: string) => commandMenu(agent, command, '', snapshots);
  const query = (request: MenuQuery): Promise<ClaudeFrame> => {
    // Each menu visit owns its data snapshot. Navigation reuses it; reopening
    // the command fetches dynamic data again. File and task reads stay fresh.
    if (request.subtype === 'read_file' || request.subtype === 'get_task_output') return agent.query(request);
    const key = JSON.stringify(request);
    const previous = snapshots.get(key);
    if (previous) return previous;
    const pending = agent.query(request, { cached: true }).catch(error => {
      if (snapshots.get(key) === pending) snapshots.delete(key);
      throw error;
    });
    snapshots.set(key, pending);
    return pending;
  };
  const configure = (request: MenuChange) => { snapshots.clear(); return agent.configure(request); };
  if (Object.hasOwn(unavailable, name)) return { title: `/${name}`, description: unavailable[name]!, items: [], footer: 'Unavailable in headless Claude' };

  if (name === 'help') return {
    title: 'Commands and shortcuts', description: '↑/↓ select · type to filter · Enter opens a command · Alt+Enter newline in prompts · Esc back or interrupt · Shift+Tab permission mode · Ctrl+O transcript · Ctrl+C twice to exit',
    items: [{ id: 'keyboard', label: 'Keyboard shortcuts', description: 'Menu navigation and prompt editing run locally. A remote request runs only on opening a data view or confirming an action.' },
      ...[...new Map([...agent.commands, ...menuCommands, { name: 'model', description: 'Choose a model', argumentHint: '' }].map(command => [command.name, command])).values()].map(command => ({
        id: command.name, label: `/${command.name} ${command.argumentHint}`, description: command.description,
        run: () => menuCommand(`/${command.name}`) ? open(command.name) : { draft: `/${command.name} ` },
      } satisfies MenuItem))],
  };
  if (name === 'model') {
    if (!argument) await agent.refreshModels();
    const page: MenuPage = { title: 'Choose model', pendingLabel: 'Switching model…', footer: '/model <name> also accepts a full model ID', items: [] };
    page.items = agent.models.map(model => ({ id: model.value, label: model.displayName, description: model.description, current: model.value === agent.model,
      run: async () => { snapshots.clear(); await agent.setModel(model.value); return message(`Model changed to ${model.displayName}`); } }));
    if (argument) return { ...page, title: 'Change model', items: [{ id: argument, label: argument, run: async () => { snapshots.clear(); await agent.setModel(argument); return message(`Model changed to ${agent.model}`); } }] };
    if (!page.items.length) throw new Error('Claude did not provide a model list. Use /model <name> to choose a model.');
    return page;
  }
  if (name === 'config') {
    if (argument) {
      const match = /^(model|effortLevel|outputStyle|fastMode)=(.+)$/u.exec(argument);
      if (!match) throw new Error('Choose a setting in /config. Supported key=value settings: model, effortLevel, outputStyle, fastMode.');
      const command = { model: 'model', effortLevel: 'effort', outputStyle: 'output-style', fastMode: 'fast' }[match[1]!]!;
      const value = match[1] === 'fastMode' ? ({ true: 'on', false: 'off' }[match[2]!] ?? match[2]!) : match[2]!;
      return commandMenu(agent, command, value, snapshots);
    }
    const settings = await query({ subtype: 'get_settings' });
    return { title: 'Workspace settings', description: 'Confirmed changes are saved for future sessions in this remote workspace.', items: [
      ...[['model', `Model: ${agent.model}`], ['effort', `Effort: ${str(object(settings.applied).effort, 'default')}`], ['output-style', `Output style: ${str(agent.info.output_style, 'default')}`], ['fast', `Fast mode: ${str(agent.info.fast_mode_state, 'unavailable')}`], ['permissions', `Permissions: ${str(agent.info.current_permission_mode, 'default')}`]].map(([command, label]) => ({ id: command!, label: label!, run: () => open(command!) })),
      { id: 'effective', label: 'Inspect effective settings', run: () => inspect('Effective settings', settings.effective, () => open('config')) },
      ...records(settings.sources).map((source, index) => ({ id: `source-${index}`, label: `Source: ${str(source.source, String(index))}`, run: () => inspect('Settings source', source, () => open('config')) })),
    ] };
  }
  if (name === 'effort') {
    const settings = await query({ subtype: 'get_settings' });
    const current = str(object(settings.applied).effort);
    const model = agent.models.find(model => model.value === agent.model || model.resolvedModel === agent.model);
    const levels = model?.supportedEffortLevels ?? [];
    if (!levels.length) return { title: 'Choose effort', description: 'Claude did not advertise effort levels for this model. Choose a supported model with /model first.', items: [] };
    if (argument && !levels.includes(argument)) throw new Error(`Claude offers these effort levels for this model: ${levels.join(', ')}`);
    const choices = argument ? [argument] : levels;
    return { title: 'Choose effort', description: 'Saved for this workspace; available levels come from Claude’s model catalog.', items: choices.map(level => ({ id: level, label: level, current: !argument && level === current, run: async () => {
      await configure({ subtype: 'apply_flag_settings', settings: { effortLevel: level } }); return message(`Effort changed to ${level}`);
    } })) };
  }
  if (name === 'output-style') {
    const styles = strings(agent.info.available_output_styles);
    if (argument && !styles.includes(argument)) throw new Error('Choose an output style from the remote Claude catalog.');
    return { title: 'Choose output style', description: 'Saved for this workspace; styles come from the remote workspace.', items: (argument ? [argument] : styles).map(style => ({ id: style, label: style, current: !argument && style === agent.info.output_style, run: async () => {
      await configure({ subtype: 'apply_flag_settings', settings: { outputStyle: style } }); return message(`Output style changed to ${style}`);
    } })) };
  }
  if (name === 'fast') {
    if (argument && !['on', 'off'].includes(argument)) throw new Error('Use /fast on or /fast off.');
    const reason = str(agent.info.fast_mode_disabled_reason);
    const supported = agent.models.find(model => model.value === agent.model || model.resolvedModel === agent.model)?.supportsFastMode;
    return { title: 'Fast mode', description: reason ? `Claude reports fast mode unavailable: ${reason}` : supported ? 'Fast mode changes token pricing. This setting is saved for future sessions in this workspace.' : 'Claude did not advertise fast mode for this model.', items: (argument ? [argument] : ['off', 'on']).map(value => ({
      id: value, label: value, current: !argument && agent.info.fast_mode_state === value, disabled: value === 'on' && (!!reason || !supported), run: () => confirm('Change fast mode?', `Save fast mode ${value} for this workspace. Fast mode can increase token pricing.`, () => open('fast'), async () => {
        await configure({ subtype: 'apply_flag_settings', settings: { fastMode: value === 'on' } }); return message(`Fast mode ${value}`);
      }),
    })) };
  }
  if (name === 'permissions') {
    const settings = await query({ subtype: 'get_settings' });
    const rules = object(object(settings.effective).permissions);
    return { title: 'Permissions', description: 'Mode changes are saved for future sessions in this workspace. Configured rules are read-only; the pinned Claude API cannot edit them.', items: [
      ...[
        ['default', 'Default', 'Ask for approval when required.'], ['acceptEdits', 'Accept edits', 'Allow file edits automatically; other actions still follow Claude’s permission rules.'],
        ['plan', 'Plan', 'Plan work without making edits.'], ['dontAsk', 'Don’t ask', 'Deny actions that are not already approved.'],
      ].map(([mode, label, description]) => ({ id: mode!, label: label!, description: description!, current: agent.info.current_permission_mode === mode, run: () => confirm('Change permission mode?', `${description!} Saved for future sessions in this workspace.`, () => open('permissions'), async () => {
        await configure({ subtype: 'set_permission_mode', mode: mode! }); return message(`Permission mode changed to ${label}`);
      }) })),
      ...['allow', 'ask', 'deny'].map(kind => ({ id: kind, label: `${kind}: ${strings(rules[kind]).length} configured rules`, run: () => inspect(`${kind} rules`, rules[kind] ?? [], () => open('permissions')) })),
    ] };
  }
  if (name === 'mcp') {
    const response = await query({ subtype: 'mcp_status' });
    const servers = records(response.mcpServers).filter(server => typeof server.name === 'string');
    if (argument) {
      const match = /^(reconnect|enable|disable)(?:\s+(.+))?$/u.exec(argument);
      if (!match) throw new Error('Use /mcp, or /mcp reconnect|enable|disable [server|all].');
      const candidates = match[2] && match[2] !== 'all' ? servers.filter(server => server.name === match[2]) : servers;
      if (!candidates.length) throw new Error('No matching MCP server in the remote session.');
      return { title: `MCP ${match[1]}`, items: candidates.map(server => ({ id: str(server.name), label: str(server.name), run: () => confirm(`${match[1]} MCP server?`, str(server.name), () => open('mcp'), async () => {
        await configure(match[1] === 'reconnect' ? { subtype: 'mcp_reconnect', serverName: str(server.name) } : { subtype: 'mcp_toggle', serverName: str(server.name), enabled: match[1] === 'enable' });
        return open('mcp');
      }) })) };
    }
    return { title: 'MCP servers', items: servers.map(server => ({ id: str(server.name), label: `${server.name}: ${str(server.status, 'unknown')}`, description: str(server.error), run: () => ({
      title: str(server.name), description: `Status: ${str(server.status, 'unknown')}`, back: () => open('mcp'), items: [
        { id: 'details', label: 'Server details and tools', run: () => inspect(str(server.name), server, () => open('mcp')) },
        { id: 'reconnect', label: 'Reconnect', run: async () => { await configure({ subtype: 'mcp_reconnect', serverName: str(server.name) }); return open('mcp'); } },
        ...[true, false].map(enabled => ({ id: String(enabled), label: enabled ? 'Enable' : 'Disable', run: () => confirm(`${enabled ? 'Enable' : 'Disable'} MCP server?`, str(server.name), () => open('mcp'), async () => {
          await configure({ subtype: 'mcp_toggle', serverName: str(server.name), enabled }); return open('mcp');
        }) })),
      ],
    }) })) };
  }
  if (name === 'hooks') {
    try { return inspect('Hooks', await query({ subtype: 'get_hooks_listing' })); }
    catch (error) { if (!unsupported(error)) throw error; }
    const settings = await query({ subtype: 'get_settings' });
    const sources = records(settings.sources).filter(source => object(source.settings).hooks !== undefined);
    return { title: 'Configured hooks', description: 'Read-only settings view. This Claude version cannot expose its full native hook editor or plugin hook inventory.', items: sources.length ? sources.map((source, index) => ({
      id: String(index), label: str(source.source, `Source ${index + 1}`), run: () => inspect('Hook configuration', object(source.settings).hooks, () => open('hooks')),
    })) : [{ id: 'effective', label: 'Effective hook settings', run: () => inspect('Hook configuration', object(settings.effective).hooks ?? {}, () => open('hooks')) }] };
  }
  if (name === 'context' || name === 'memory') {
    const context = await query({ subtype: 'get_context_usage', detail: 'summary' });
    if (name === 'memory') return { title: 'Loaded memory files', description: 'Files loaded by this remote session. Reading a file follows Claude’s permission checks.', items: records(context.memoryFiles).filter(file => typeof file.path === 'string').map((file, index) => ({ id: String(index), label: str(file.path), description: `${file.tokens ?? '?'} tokens · ${str(file.type)}`, run: async () => {
      const result = await agent.query({ subtype: 'read_file', path: str(file.path), max_bytes: 32 * 1024 });
      return inspect(`${file.path}${result.truncated ? ' (truncated)' : ''}`, str(result.contents), () => open('memory'));
    } })) };
    return { title: 'Context usage', description: `${context.totalTokens ?? '?'} / ${context.maxTokens ?? '?'} tokens · ${context.percentage ?? '?'}% · Summary estimates`, items: [
      ...records(context.categories).map((category, index) => ({ id: String(index), label: `${str(category.name)}: ${category.tokens ?? '?'} tokens`, description: str(category.kind), run: () => inspect(str(category.name), category, () => open('context')) })),
      { id: 'memory', label: 'Loaded memory files', run: () => open('memory') },
      { id: 'details', label: 'Detailed summary', run: () => inspect('Context details', context, () => open('context')) },
    ] };
  }
  if (name === 'usage') {
    try { return inspect('Usage and plan limits', await query({ subtype: 'get_usage', skip_behaviors: true })); }
    catch (error) { if (!unsupported(error)) throw error; }
    const usage = await query({ subtype: 'get_session_cost' });
    return inspect('Session usage', str(usage.text, 'Claude did not return session usage.'));
  }
  if (name === 'agents') return { title: 'Available agents', description: 'Definitions advertised by the remote Claude session. Edit .claude/agents/ to create or change agents.', items: records(agent.info.agents).map((item, index) => ({
    id: String(index), label: str(item.name), description: str(item.description), run: () => inspect(str(item.name), item, () => open('agents')),
  })) };
  if (name === 'skills') return { title: 'Skills and commands', description: 'Commands advertised by the remote Claude session.', items: agent.commands.map(command => ({ id: command.name, label: `/${command.name}`, description: command.description,
    run: () => ({ draft: `/${command.name} ` }),
  })) };
  if (name === 'reload-skills' || name === 'reload-plugins') return confirm(`/${name}`, 'Reload remote definitions into this running session.', () => open(name === 'reload-skills' ? 'skills' : 'plugin'), async () => {
    await configure({ subtype: name === 'reload-skills' ? 'reload_skills' : 'reload_plugins' }); return open(name === 'reload-skills' ? 'skills' : 'plugin');
  });
  if (name === 'plugin') {
    const settings = await query({ subtype: 'get_settings' });
    const enabled = object(object(settings.effective).enabledPlugins);
    const plugins = records(agent.info.plugins);
    return { title: 'Plugins', description: 'Loaded and configured plugins. Install, remove, and marketplace management require Claude’s native CLI.', items: [
      ...plugins.map((plugin, index) => ({ id: `loaded-${index}`, label: `${str(plugin.name)} (loaded)`, run: () => inspect('Plugin details', plugin, () => open('plugin')) })),
      ...Object.entries(enabled).map(([name, value]) => ({ id: `configured-${name}`, label: `${name}: ${value === true ? 'enabled' : 'disabled'} (configured)` })),
      { id: 'reload', label: 'Reload plugins', run: () => open('reload-plugins') },
    ] };
  }
  if (name === 'tasks') return { title: 'Background tasks', description: 'Tasks reported by this session. Reopen or refresh to see updates.', items: [
    ...[...agent.tasks.entries()].map(([id, task]) => ({ id, label: `${str(task.description, id)}: ${str(task.status, 'running')}`, run: () => ({
      title: str(task.description, id), back: () => open('tasks'), items: [
        { id: 'details', label: 'Task details', run: () => inspect('Task details', task, () => open('tasks')) },
        { id: 'output', label: 'Read output', run: async () => { const output = await agent.query({ subtype: 'get_task_output', task_id: id }); return inspect('Task output', str(output.output), () => open('tasks')); } },
        { id: 'stop', label: 'Stop task', disabled: task.status !== 'running', run: () => confirm('Stop task?', str(task.description, id), () => open('tasks'), async () => { await configure({ subtype: 'stop_task', task_id: id }); return message('Task stop requested'); }) },
      ],
    }) })),
    { id: 'refresh', label: 'Refresh tasks', run: () => open('tasks') },
  ] };
  if (name === 'rename') return { title: 'Rename conversation', items: [], input: { label: 'Name', initial: argument, submit: async title => {
    if (title.length > 200 || /[\x00-\x1f\x7f]/u.test(title)) throw new Error('Use a single-line name up to 200 characters.');
    await configure({ subtype: 'rename_session', title }); return message(`Conversation renamed to ${title}`);
  } } };
  if (name === 'status') return { title: 'Remote session', items: [], details: [
    { label: 'Session', value: agent.session.id },
    { label: 'Status', value: agent.status },
    { label: 'Model', value: agent.model },
    { label: 'Permission mode', value: str(agent.info.current_permission_mode, 'default') },
    { label: 'Output style', value: str(agent.info.output_style, 'default') },
    { label: 'Fast mode', value: str(agent.info.fast_mode_state, 'unavailable') },
    { label: 'Commands', value: String(agent.commands.length) },
    { label: 'Background tasks', value: String(agent.tasks.size) },
  ] };
  throw new Error(`No local menu adapter for /${name}`);
}
