import { createInterface } from 'node:readline/promises';
import type { WorkspaceAuthRef } from '@cantelop/sdk';

export async function ensureLogin(auth: WorkspaceAuthRef, signal: AbortSignal): Promise<void> {
  if (await auth.status({ signal })) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('Claude sign-in required in this workspace. Run juiced login in an interactive terminal first.');
  }
  const attempt = await auth.login({ signal });
  if (attempt.authenticated) return;
  const cancelled = new AbortController();
  const loginSignal = AbortSignal.any([signal, cancelled.signal]);
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const cancel = () => cancelled.abort(new Error('Claude sign-in cancelled'));
  readline.on('SIGINT', cancel);
  readline.once('close', cancel);
  let authenticated = false;
  try {
    process.stderr.write(`Sign in to Claude using this URL:\n${attempt.url}\n\n`);
    while (!authenticated) {
      const code = (await readline.question('Paste the authorization code: ', { signal: loginSignal })).trim();
      if (!code) continue;
      try {
        authenticated = await auth.submitCode({ attemptId: attempt.attemptId, code, signal: loginSignal });
      } catch (error) {
        if ((error as { code?: string }).code !== 'code_rejected') throw error;
        process.stderr.write('Claude rejected that code. Try again.\n');
      }
    }
    process.stderr.write('Claude is signed in to this workspace.\n');
  } finally {
    readline.close();
    if (!authenticated) await auth.cancelLogin({ attemptId: attempt.attemptId, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}
