import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import type { AppEnvironment } from '@cantelop/sdk';
import { readEnvironmentValue, updateEnvironment } from './environment.js';

const execute = promisify(execFile);
export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Juiced&contents=write&pull_requests=write&expires_in=30';
export const GITHUB_CONFIGURE_HELP = `Usage: juiced claude github-configure [--stdin]

Configure GitHub access for all Juiced workspaces without redeploying.
Uses GH_TOKEN from your environment, then an existing local gh credential.
If neither is available, opens GitHub's token page and asks for a hidden paste.
Choose the repository owner and repositories, with Contents: Read and write.
Pull requests: Read and write allows PR creation; add Workflows: Write to edit workflows.

--stdin  Read a token from stdin instead of the environment, gh, or a prompt.
         Example: pbpaste | juiced claude github-configure --stdin

Verifies the GitHub account, stores GH_TOKEN as a Cantelop app secret, and waits
for propagation. No local gh or Cantelop CLI installation or Claude login is required.
Run juiced claude --new afterward; existing sessions keep their old environment.
Local Git remotes and GitHub's HTTPS credential helper are configured on launch.
`;

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
type IO = { stdin: Input; stderr: Writable & { isTTY?: boolean } };
type Services = {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  localToken: (signal: AbortSignal) => Promise<string | undefined>;
  openBrowser: (url: string, signal: AbortSignal) => Promise<void>;
  prompt: (io: IO, signal: AbortSignal) => Promise<string>;
};

/** Capture credentials in memory; never forward subprocess diagnostics to the CLI. */
async function localGitHubToken(signal: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execute('gh', ['auth', 'token', '--hostname', 'github.com'], {
      signal, timeout: 5000, maxBuffer: 64 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
    });
    return stdout.trim() || undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

async function openBrowser(url: string, signal: AbortSignal): Promise<void> {
  const [file, args] = process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const
      : ['xdg-open', [url]] as const;
  await execute(file, [...args], { signal, timeout: 5000, maxBuffer: 4096 });
}

/** Readline owns editing and raw-mode restoration; a muted output prevents token echo. */
export async function promptGitHubToken(io: IO, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const cancelled = new AbortController();
  const promptSignal = AbortSignal.any([signal, cancelled.signal]);
  const muted = new Writable({ write(_bytes, _encoding, callback) { callback(); } });
  const wasRaw = Boolean(io.stdin.isRaw);
  const readline = createInterface({ input: io.stdin, output: muted, terminal: true, historySize: 0 });
  const cancel = () => cancelled.abort(new Error('GitHub configuration cancelled.'));
  readline.once('SIGINT', cancel);
  readline.once('close', cancel);
  io.stderr.write('Paste GitHub token (hidden): ');
  try { return await readline.question('', { signal: promptSignal }); }
  finally {
    readline.close();
    if (Boolean(io.stdin.isRaw) !== wasRaw) io.stdin.setRawMode?.(wasRaw);
    muted.end();
    io.stderr.write('\n');
  }
}

function tokenValue(value: string): string {
  const token = value.trim();
  if (!token || !/^[\x21-\x7e]+$/.test(token) || Buffer.byteLength(token) > 64 * 1024) {
    throw new Error('GitHub token must be a single nonempty value without whitespace, and fit in 64 KiB.');
  }
  return token;
}

export async function verifyGitHubToken(token: string, fetcher: typeof globalThis.fetch, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetcher('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'juiced' },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error('Unable to verify the token with GitHub. Check your network connection and try again.');
  }
  if (response.status === 401) throw new Error('GitHub rejected the token. Create a valid token and retry with juiced claude github-configure --stdin.');
  if (!response.ok) throw new Error(`GitHub could not verify the token (HTTP ${response.status}). Check token access and try again.`);
  let user: unknown;
  try { user = await response.json(); } catch { throw new Error('GitHub returned an invalid account response.'); }
  const login = (user as { login?: unknown } | null)?.login;
  if (typeof login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) throw new Error('GitHub returned an invalid account response.');
  return login;
}

export async function configureGitHub(api: AppEnvironment, stdin: boolean, io: IO, signal: AbortSignal, overrides: Partial<Services> = {}): Promise<void> {
  const services: Services = { env: process.env, fetch: globalThis.fetch, localToken: localGitHubToken, openBrowser, prompt: promptGitHubToken, ...overrides };
  signal.throwIfAborted();
  io.stderr.write('Configuring GitHub access for all Juiced workspaces.\n');
  let token: string | undefined;
  if (stdin) token = await readEnvironmentValue(io.stdin, signal);
  else if (services.env.GH_TOKEN?.trim()) {
    token = services.env.GH_TOKEN;
    io.stderr.write('Using GH_TOKEN from your environment.\n');
  } else {
    token = await services.localToken(signal);
    if (token) io.stderr.write('Using your local gh credential for github.com.\n');
  }
  if (!token) {
    if (!io.stdin.isTTY || !io.stderr.isTTY) throw new Error('No GitHub credential found. Run juiced claude github-configure in an interactive terminal, set GH_TOKEN, or pipe a token with --stdin.');
    io.stderr.write(`Create a token in GitHub:\n${GITHUB_TOKEN_URL}\n\nChoose the repository owner and repositories. Grant Contents: Read and write\nand Pull requests: Read and write. Add Workflows: Write to edit workflow files.\nCopy the generated token and paste it below.\n`);
    try { await services.openBrowser(GITHUB_TOKEN_URL, signal); }
    catch { signal.throwIfAborted(); io.stderr.write('Could not open a browser. Open the URL above to continue.\n'); }
    token = await services.prompt(io, signal);
  }
  token = tokenValue(token);
  const login = await verifyGitHubToken(token, services.fetch, signal);
  io.stderr.write(`Authenticated with GitHub as ${login}.\n`);
  await updateEnvironment(api, 'set', 'GH_TOKEN', true, { stdin: Readable.from([token]), stderr: io.stderr }, signal);
  io.stderr.write('GitHub configured. Run juiced claude --new from your project to use it.\nLocal Git remotes and GitHub authentication are configured on launch.\n');
}
