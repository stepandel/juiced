import { StringDecoder } from 'node:string_decoder';

export type ClaudeFrame = Record<string, unknown>;
export const object = (value: unknown): ClaudeFrame => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeFrame : {};

/** JSONL boundaries and UTF-8 characters need not match Cantelop event boundaries. */
export class ClaudeDecoder {
  private decoder = new StringDecoder('utf8');
  // A partial line is kept as chunks with a running byte count: rescanning or measuring the whole
  // buffer on every push is quadratic for multi-megabyte frames delivered in small events.
  private pending: string[] = [];
  private pendingBytes = 0;
  push(bytes: Buffer): ClaudeFrame[] {
    const text = this.decoder.write(bytes);
    const frames: ClaudeFrame[] = [];
    let start = 0;
    try {
      for (let end; (end = text.indexOf('\n', start)) !== -1;) {
        const line = (this.pending.length ? this.pending.join('') + text.slice(start, end) : text.slice(start, end)).trim();
        this.pending = []; this.pendingBytes = 0; start = end + 1;
        if (!line) continue;
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('Claude output exceeded the JSON frame limit');
        const frame = JSON.parse(line) as unknown;
        if (typeof object(frame).type !== 'string') throw new Error('Invalid Claude protocol frame');
        frames.push(object(frame));
      }
    } finally {
      if (start < text.length) { const rest = text.slice(start); this.pending.push(rest); this.pendingBytes += Buffer.byteLength(rest); }
    }
    if (this.pendingBytes > 4 * 1024 * 1024) throw new Error('Claude output exceeded the JSON frame limit');
    return frames;
  }
  finish(): void {
    if ((this.pending.join('') + this.decoder.end()).trim()) throw new Error('Claude exited with an incomplete JSON frame');
  }
}

/** `suggestions` are Claude's own "don't ask again" permission updates for this request. */
export type Approval = { id: string; tool: string; input: ClaudeFrame; description: string; local?: boolean; suggestions?: ClaudeFrame[] };
/** Optional parts of an answer: a remembered grant, or what Claude should do instead. */
export type ApprovalOptions = { suggestions?: ClaudeFrame[]; message?: string };
export type SlashCommand = { name: string; description: string; argumentHint: string };
export type ModelOption = { value: string; displayName: string; description: string; supportedEffortLevels?: string[]; supportsFastMode?: boolean; resolvedModel?: string };

export function modelOptions(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) return [];
  const models = new Map<string, ModelOption>();
  for (const raw of value) {
    const model = object(raw);
    if (typeof model.value !== 'string' || !model.value || /\s|[\x00-\x1f\x7f-\x9f]/u.test(model.value)) continue;
    models.set(model.value, { value: model.value, displayName: typeof model.displayName === 'string' ? model.displayName : model.value, description: typeof model.description === 'string' ? model.description : '',
      ...(Array.isArray(model.supportedEffortLevels) ? { supportedEffortLevels: [...new Set(model.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && /^[a-z]+$/u.test(level)))] } : {}),
      ...(typeof model.supportsFastMode === 'boolean' ? { supportsFastMode: model.supportsFastMode } : {}),
      ...(typeof model.resolvedModel === 'string' ? { resolvedModel: model.resolvedModel } : {}),
    });
  }
  return [...models.values()];
}

export function slashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands = new Map<string, SlashCommand>();
  for (const raw of value) {
    const command = typeof raw === 'string' ? { name: raw } : object(raw);
    if (typeof command.name !== 'string' || !/^[^\s/\\\x00-\x1f\x7f-\x9f]+$/u.test(command.name)) continue;
    const names = [command.name, ...(Array.isArray(command.aliases) ? command.aliases.filter((alias): alias is string => typeof alias === 'string' && /^[^\s/\\\x00-\x1f\x7f-\x9f]+$/u.test(alias)) : [])];
    for (const name of names) commands.set(name, { name, description: typeof command.description === 'string' ? command.description : '', argumentHint: typeof command.argumentHint === 'string' ? command.argumentHint : '' });
  }
  return [...commands.values()];
}

export function headlessArguments(argv: string[]): string[] {
  return [...argv, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
}

export function useLocalTui(argv: string[], tty: boolean): boolean {
  return tty && !argv.some(arg => ['-p', '--print', '--help', '-h', '--version', '-v', '--output-format', '--input-format'].includes(arg) || /^--(?:print|output-format|input-format)=/.test(arg));
}
