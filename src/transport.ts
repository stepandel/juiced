import { randomUUID } from 'node:crypto';

/** Shared Cantelop request/stream helpers: retry policy, backoff, signals and IDs. */
const TRANSIENT = /stream|fetch|network|socket|terminated|connection|timed out/i;

/**
 * HTTP-like errors retry only on 0 (no response) or 5xx; a 4xx is never retried
 * whatever its message says. Callers must check their own signal first so a
 * local cancellation (also an AbortError) is never mistaken for a dropped request.
 */
export function isTransient(error: unknown): boolean {
  const remote = (error ?? {}) as { status?: unknown; name?: unknown; message?: unknown };
  if (typeof remote.status === 'number') return remote.status === 0 || remote.status >= 500;
  return remote.name === 'AbortError' || typeof remote.message === 'string' && TRANSIENT.test(remote.message);
}

/** Exponential delay for a zero-based retry attempt. */
export function backoffMs(attempt: number, { base = 250, max = 5000 }: { base?: number; max?: number } = {}): number {
  return Math.min(max, base * 2 ** Math.min(attempt, 30));
}

/** Cantelop message IDs; a fixed UUID keeps retries of one delivery idempotent. */
export const messageId = (uuid: string = randomUUID()) => `msg_${uuid.replaceAll('-', '')}`;

const code = (error: unknown) => String((error as { code?: unknown } | null | undefined)?.code);
/** A session that has never been viewed has no view yet; treat as "no boundary". */
export const isViewMissing = (error: unknown) => ['session_view_not_found', 'session_not_found', 'resource_not_found'].includes(code(error));
/** The retained event window no longer covers the requested cursor. */
export const isCursorExpired = (error: unknown) => ['event_cursor_expired', 'event_stream_reset'].includes(code(error));

/**
 * A child of a long-lived signal that unregisters when disposed. AbortSignal.any
 * keeps every dependent registered on its parent for the parent's lifetime
 * (~250 B each on Node 22), which grows without bound per request or heartbeat.
 */
export function linkSignal(parent: AbortSignal, timeoutMs?: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (parent.aborted) onAbort();
  else {
    parent.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      // Same reason as AbortSignal.timeout, and likewise never keeps the process alive.
      timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
      timer.unref?.();
    }
  }
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', onAbort); } };
}

/** Run one call under `parent` plus a deadline, releasing both when it settles. */
export async function withTimeout<T>(parent: AbortSignal, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const link = linkSignal(parent, timeoutMs);
  try { return await work(link.signal); } finally { link.dispose(); }
}
