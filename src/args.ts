import { inspectionScope } from './inspection-protocol.js';

export type Arguments =
  | { command: 'help' | 'version'; workspace: string | undefined; argv: string[] }
  | ({ command: 'claude'; workspace: string | undefined; argv: string[] } & (
    | { action: 'run' | 'login' | 'fast-forward' }
    | { action: 'delete'; yes: boolean }
    | { action: 'ls'; path: string; includeIgnored: boolean }
    | { action: 'peek'; path: string; includeIgnored: boolean; changesOnly: boolean }
    | { action: 'sync'; direction: 'to-workspace' | 'from-workspace'; includeUncommitted: boolean }
  ));

export function parseArguments(args: string[], env: NodeJS.ProcessEnv = process.env): Arguments {
  let workspace = env.JUICED_WORKSPACE;
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === '--workspace') {
      workspace = args[++index] ?? '';
      index++;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
      index++;
    } else break;
  }
  if (workspace !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspace)) throw new Error('Workspace must be 1–63 lowercase letters, numbers, or hyphens');
  const command = args[index];
  const argv = args.slice(index + 1);
  if (command === 'claude') {
    if (argv[0] === '--') return { command, action: 'run', workspace, argv: argv.slice(1) };
    if (argv[0] === 'ls' || argv[0] === 'peek') {
      const action = argv[0];
      const usage = `Usage: juiced claude ${action} [--include-ignored]${action === 'peek' ? ' [--changes-only]' : ''} [PATH]`;
      if (argv.length === 2 && ['--help', '-h'].includes(argv[1]!)) return { command: 'help', workspace, argv: [] };
      let path: string | undefined, includeIgnored = false, changesOnly = false, literal = false;
      for (const arg of argv.slice(1)) {
        if (!literal && arg === '--') { literal = true; continue; }
        if (!literal && arg === '--include-ignored' && !includeIgnored) { includeIgnored = true; continue; }
        if (!literal && arg === '--changes-only' && action === 'peek' && !changesOnly) { changesOnly = true; continue; }
        if ((!literal && arg.startsWith('-')) || path !== undefined) throw new Error(usage);
        path = arg;
      }
      if (includeIgnored && path === undefined) throw new Error('--include-ignored requires an explicit PATH.');
      inspectionScope(path);
      const options = { command: 'claude' as const, workspace, path: path ?? '.', includeIgnored, argv: [] };
      return action === 'peek' ? { ...options, action, changesOnly } : { ...options, action };
    }
    if (argv[0] === 'delete') {
      if (argv.length !== 1 && !(argv.length === 2 && argv[1] === '--yes')) throw new Error('Usage: juiced claude delete [--yes]');
      return { command, action: 'delete', workspace, yes: argv[1] === '--yes', argv: [] };
    }
    if (argv[0] === 'login') {
      if (argv.length !== 1) throw new Error('Usage: juiced claude login');
      return { command, action: 'login', workspace, argv: [] };
    }
    if (argv[0] === 'sync') {
      const flags = argv.slice(1);
      const directions = flags.filter(arg => arg === '--to-workspace' || arg === '--from-workspace');
      if (directions.length !== 1 || flags.some(arg => !['--to-workspace', '--from-workspace', '--include-uncommitted'].includes(arg)) || new Set(flags).size !== flags.length || flags.includes('--include-uncommitted') && directions[0] !== '--to-workspace') {
        throw new Error('Usage: juiced claude sync --to-workspace [--include-uncommitted] | --from-workspace');
      }
      return { command, action: 'sync', workspace, direction: directions[0]!.slice(2) as 'to-workspace' | 'from-workspace', includeUncommitted: flags.includes('--include-uncommitted'), argv: [] };
    }
    if (argv[0] === 'fast-forward') {
      if (argv.length !== 1) throw new Error('Usage: juiced claude fast-forward');
      return { command, action: 'fast-forward', workspace, argv: [] };
    }
    return { command, action: 'run', workspace, argv };
  }
  if (command === 'login') throw new Error('juiced login has moved. Run juiced claude login.');
  if (command === 'delete') throw new Error('Run juiced claude delete [--yes] to delete the workspace for this directory.');
  if (command === '--version' || command === '-v') return { command: 'version', workspace, argv: [] };
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { command: 'help', workspace, argv: [] };
  throw new Error(`Unknown command: ${command}. Run juiced --help.`);
}

export const HELP = `Run Claude Code on Cantelop with Juiced's local terminal interface.

Usage:
  juiced [--workspace SLUG] claude [Claude arguments...]
  juiced [--workspace SLUG] claude login
  juiced [--workspace SLUG] claude sync --to-workspace [--include-uncommitted]
  juiced [--workspace SLUG] claude sync --from-workspace
  juiced [--workspace SLUG] claude fast-forward
  juiced [--workspace SLUG] claude delete [--yes]
  juiced [--workspace SLUG] claude ls [--include-ignored] [PATH]
  juiced [--workspace SLUG] claude peek [--include-ignored] [--changes-only] [PATH]

Examples:
  juiced claude login
  juiced claude
  juiced claude --model sonnet
  juiced --workspace my-project claude
  echo "Explain this project" | juiced claude -p

Options before the command:
  --workspace SLUG  Override the workspace derived from the current directory
                   (JUICED_WORKSPACE also overrides automatic selection)
  -h, --help        Show this help
  -v, --version     Show version

Interactive sessions use local prompt editing and streamed remote responses.
Enter sends, Alt+Enter adds a line, Esc interrupts, and /exit quits.
Claude flags configure the remote process. -p, --help, --version, and pipes
use native CLI passthrough.
Each invocation starts a new session. Files and Claude login persist in the
remote workspace. Git repositories initialize from local HEAD once, then retain
remote commits and edits. Use sync to explicitly transfer commits; fast-forward
optionally applies imported commits to a clean local source branch. To include
uncommitted work, run sync --to-workspace --include-uncommitted before launching.
Delete removes the entire remote workspace, including its files and Claude login.
It asks for confirmation; --yes confirms deletion in scripts. Local files are kept.
ls lists immediate remote entries. peek compares local and remote entries side
by side, including matches; --changes-only hides matching entries. Directory
status includes descendants. Pass a path to drill down one level. Both inspect
current Git-visible contents without syncing, changing the real index, or starting
Claude. Ignored files are excluded; --include-ignored requires an explicit PATH.
Use juiced claude -- <prompt> for literal prompts named login, sync, fast-forward,
delete, ls, or peek. Workspace operations use app credentials through the SDK.
Non-Git directories keep continuous file sync, excluding .git, .env*,
node_modules, dist, and coverage.
Claude login is separate for each project workspace.

First run: deploy this project's runtime with cantelop deploy, then run
juiced claude login to sign in to Claude inside the remote workspace. See README.md.
`;
