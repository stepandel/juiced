export type Arguments =
  | { command: 'claude' | 'login' | 'help' | 'version'; workspace: string | undefined; argv: string[] }
  | { command: 'sync'; workspace: string | undefined; direction: 'to-workspace' | 'from-workspace'; includeUncommitted: boolean; argv: string[] }
  | { command: 'fast-forward'; workspace: string | undefined; argv: string[] };

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
    if (argv[0] === '--') return { command, workspace, argv: argv.slice(1) };
    if (argv[0] === 'sync') {
      const flags = argv.slice(1);
      const directions = flags.filter(arg => arg === '--to-workspace' || arg === '--from-workspace');
      if (directions.length !== 1 || flags.some(arg => !['--to-workspace', '--from-workspace', '--include-uncommitted'].includes(arg)) || new Set(flags).size !== flags.length || flags.includes('--include-uncommitted') && directions[0] !== '--to-workspace') {
        throw new Error('Usage: juiced claude sync --to-workspace [--include-uncommitted] | --from-workspace');
      }
      return { command: 'sync', workspace, direction: directions[0]!.slice(2) as 'to-workspace' | 'from-workspace', includeUncommitted: flags.includes('--include-uncommitted'), argv: [] };
    }
    if (argv[0] === 'fast-forward') {
      if (argv.length !== 1) throw new Error('Usage: juiced claude fast-forward');
      return { command: 'fast-forward', workspace, argv: [] };
    }
    return { command, workspace, argv };
  }
  if (command === 'login' && argv.length === 0) return { command, workspace, argv };
  if (command === '--version' || command === '-v') return { command: 'version', workspace, argv: [] };
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { command: 'help', workspace, argv: [] };
  throw new Error(`Unknown command: ${command}. Run juiced --help.`);
}

export const HELP = `Run Claude Code on Cantelop with Juiced's local terminal interface.

Usage:
  juiced [--workspace SLUG] claude [Claude arguments...]
  juiced [--workspace SLUG] claude sync --to-workspace [--include-uncommitted]
  juiced [--workspace SLUG] claude sync --from-workspace
  juiced [--workspace SLUG] claude fast-forward
  juiced [--workspace SLUG] login

Examples:
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
Use claude -- sync to send a literal prompt named sync. Non-Git directories keep
continuous file sync, excluding .git, .env*, node_modules, dist, and coverage.
Claude login is separate for each project workspace.

First run: deploy this project's runtime with cantelop deploy, then run juiced
login to sign in to Claude inside the remote workspace. See README.md.
`;
