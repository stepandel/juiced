export type Arguments = { command: 'claude' | 'login' | 'help' | 'version'; workspace: string; argv: string[] };

export function parseArguments(args: string[], env: NodeJS.ProcessEnv = process.env): Arguments {
  let workspace = env.JUICED_WORKSPACE ?? 'default';
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
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspace)) throw new Error('Workspace must be 1–63 lowercase letters, numbers, or hyphens');
  const command = args[index];
  const argv = args.slice(index + 1);
  if (command === 'claude') return { command, workspace, argv };
  if (command === 'login' && argv.length === 0) return { command, workspace, argv };
  if (command === '--version' || command === '-v') return { command: 'version', workspace, argv: [] };
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { command: 'help', workspace, argv: [] };
  throw new Error(`Unknown command: ${command}. Run juiced --help.`);
}

export const HELP = `Run Claude Code on Cantelop with Juiced's local terminal interface.

Usage:
  juiced [--workspace SLUG] claude [Claude arguments...]
  juiced [--workspace SLUG] login

Examples:
  juiced claude
  juiced claude --model sonnet
  juiced --workspace my-project claude
  echo "Explain this project" | juiced claude -p

Options before the command:
  --workspace SLUG  Persistent remote workspace (default: JUICED_WORKSPACE or default)
  -h, --help        Show this help
  -v, --version     Show version

Interactive sessions use local prompt editing and streamed remote responses.
Enter sends, Alt+Enter adds a line, Esc interrupts, and /exit quits.
Claude flags configure the remote process. -p, --help, --version, and pipes
use native CLI passthrough.
Each invocation starts a new session. Files and Claude login persist in the
remote workspace. Local files are not uploaded.

First run: deploy this project's runtime with cantelop deploy, then run juiced
login to sign in to Claude inside the remote workspace. See README.md.
`;
