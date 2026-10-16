import { StringDecoder } from 'node:string_decoder';

export type ClaudeFrame = Record<string, unknown>;
export const object = (value: unknown): ClaudeFrame => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeFrame : {};

/** JSONL boundaries and UTF-8 characters need not match Cantelop event boundaries. */
export class ClaudeDecoder {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  push(bytes: Buffer): ClaudeFrame[] {
    this.pending += this.decoder.write(bytes);
    const frames: ClaudeFrame[] = [];
    for (let end; (end = this.pending.indexOf('\n')) !== -1;) {
      const line = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('Claude output exceeded the JSON frame limit');
      const frame = JSON.parse(line) as unknown;
      if (typeof object(frame).type !== 'string') throw new Error('Invalid Claude protocol frame');
      frames.push(object(frame));
    }
    if (Buffer.byteLength(this.pending) > 4 * 1024 * 1024) throw new Error('Claude output exceeded the JSON frame limit');
    return frames;
  }
  finish(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) throw new Error('Claude exited with an incomplete JSON frame');
  }
}

export type Approval = { id: string; tool: string; input: ClaudeFrame; description: string };

export function headlessArguments(argv: string[]): string[] {
  return [...argv, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
}

export function useLocalTui(argv: string[], tty: boolean): boolean {
  return tty && !argv.some(arg => ['-p', '--print', '--help', '-h', '--version', '-v', '--output-format', '--input-format'].includes(arg) || /^--(?:print|output-format|input-format)=/.test(arg));
}
