import type { AppEnvironment } from '@cantelop/sdk';
import type { Readable, Writable } from 'node:stream';

/** Tokens enter through stdin, never through arguments, prompts, or diagnostic output. */
export async function readEnvironmentValue(input: Readable & { isTTY?: boolean }, signal: AbortSignal): Promise<string> {
  if (input.isTTY) throw new Error('Pipe the value into stdin; environment values are not accepted as command arguments.');
  signal.throwIfAborted();
  const abort = () => input.destroy(new Error('Environment input interrupted'));
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const raw of input) {
      const chunk = Buffer.from(raw); size += chunk.length;
      if (size > 64 * 1024 + 2) throw new Error('Environment values are limited to 64 KiB.');
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    let value: string;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, ''); }
    catch { throw new Error('Environment value must be valid UTF-8.'); }
    if (!value || value.includes('\0') || Buffer.byteLength(value) > 64 * 1024) throw new Error('Environment value must be nonempty, contain no NUL, and fit in 64 KiB.');
    return value;
  } finally { signal.removeEventListener('abort', abort); }
}

export async function updateEnvironment(api: AppEnvironment, action: 'set' | 'unset', name: string, secret: boolean,
  io: { stdin: Readable & { isTTY?: boolean }; stderr: Writable }, signal: AbortSignal) {
  const options = { secret, signal };
  const update = action === 'set' ? await api.set(name, await readEnvironmentValue(io.stdin, signal), options) : await api.unset(name, options);
  io.stderr.write(`Waiting for ${name} configuration to propagate…\n`);
  await api.wait(update.revision, { signal });
  io.stderr.write(`${action === 'set' ? 'Set' : 'Unset'} ${name} for the Juiced app. New sessions use this configuration; active sessions keep their existing environment.\n`);
}
