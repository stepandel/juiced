import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { WorkspaceAuthRef } from '@cantelop/sdk';

type LoginOptions = {
  workspace?: string | undefined;
  io?: { stdin: Readable & { isTTY?: boolean }; stderr: Writable & { isTTY?: boolean } };
};

export async function ensureLogin(auth: WorkspaceAuthRef, signal: AbortSignal, options: LoginOptions = {}): Promise<void> {
  const { stdin, stderr } = options.io ?? process;
  const command = `juiced${options.workspace ? ` --workspace ${options.workspace}` : ''} claude login`;
  if (await auth.status({ signal })) return;
  if (!stdin.isTTY || !stderr.isTTY) {
    throw new Error(`Claude sign-in required in this workspace. Run ${command} in an interactive terminal first.`);
  }
  const attempt = await auth.login({ signal });
  if (attempt.authenticated) return;
  const cancelled = new AbortController();
  const loginSignal = AbortSignal.any([signal, cancelled.signal]);
  const readline = createInterface({ input: stdin, output: stderr });
  const cancel = () => cancelled.abort(new Error('Claude sign-in cancelled'));
  readline.on('SIGINT', cancel);
  readline.once('close', cancel);
  let authenticated = false;
  try {
    stderr.write(`Sign in to Claude using this URL:\n${attempt.url}\n\n`);
    while (!authenticated) {
      const code = (await readline.question('Paste the authorization code: ', { signal: loginSignal })).trim();
      if (!code) continue;
      try {
        authenticated = await auth.submitCode({ attemptId: attempt.attemptId, code, signal: loginSignal });
      } catch (error) {
        if ((error as { code?: string }).code === 'login_not_active')
          throw new Error(`This Claude sign-in attempt expired or was cancelled. Run ${command} again to get a new authorization URL and code.`, { cause: error });
        if ((error as { code?: string }).code !== 'code_rejected') throw error;
        stderr.write('Claude rejected that code. Try again.\n');
      }
    }
    stderr.write('Claude is signed in to this workspace.\n');
  } finally {
    readline.close();
    if (!authenticated) await auth.cancelLogin({ attemptId: attempt.attemptId, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}
