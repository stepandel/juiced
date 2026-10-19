import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const selectionFlags = new Set(['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--from-pr', '--teleport']);

/** Explicit Claude session selection takes precedence over the terminal binding. */
export function usesTerminalSession(argv: string[], fresh = false): boolean {
  const flags = argv.slice(0, argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--'));
  const selected = flags.some(arg => selectionFlags.has(arg.split('=')[0]!) || /^-[rc].+/u.test(arg));
  if (fresh && selected) throw new Error('--new cannot be combined with Claude session-selection flags.');
  return !selected && !flags.includes('--no-session-persistence');
}

/** Never use a TTY device name alone: a new terminal can reuse that device. */
export async function terminalIdentity(
  env: NodeJS.ProcessEnv = process.env,
  shell: () => Promise<string> = async () => {
    const { stdout } = await execute('ps', ['-p', String(process.ppid), '-o', 'lstart='], { timeout: 1000 });
    return stdout.trim() ? `${process.ppid}:${stdout.trim()}` : '';
  },
): Promise<string | undefined> {
  // A multiplexer pane must win over the outer terminal's inherited tab ID.
  if (env.TMUX && env.TMUX_PANE) return `tmux:${env.TMUX}:${env.TMUX_PANE}`;
  if (env.STY && env.WINDOW) return `screen:${env.STY}:${env.WINDOW}`;
  for (const name of ['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'WT_SESSION']) {
    if (env[name]) return `${name}:${env[name]}`;
  }
  try { const identity = await shell(); return identity ? `shell:${identity}` : undefined; }
  catch { return undefined; }
}
