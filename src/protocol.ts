export type TerminalCommand =
  | { type: 'start'; argv: string[]; tty: boolean; columns: number; rows: number; term: string; directoryName?: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; columns: number; rows: number }
  | { type: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' }
  | { type: 'eof' }
  | { type: 'heartbeat' };

export type TerminalEvent =
  | { type: 'ready' }
  | { type: 'output'; channel: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

export type TerminalReply = { ok: true };

export const MAX_INPUT_BYTES = 16 * 1024;
export const MAX_BUFFERED_INPUT = 1024 * 1024;

export function dimensions(columns: number, rows: number): void {
  if (!Number.isInteger(columns) || columns < 1 || columns > 1000 ||
      !Number.isInteger(rows) || rows < 1 || rows > 500) {
    throw new Error('Invalid terminal dimensions');
  }
}

export function decodeInput(data: string): Buffer {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('Invalid terminal input');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('Terminal input is too large');
  return bytes;
}
