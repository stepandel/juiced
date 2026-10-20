import { setTimeout as delay } from 'node:timers/promises';

type Options = {
  /** Wall-clock limit. Defaults to 10s unless `attempts` is given. */
  timeoutMs?: number;
  /** Poll-count limit; it stretches with timer delays under load, unlike `timeoutMs`. */
  attempts?: number;
  intervalMs?: number;
  message?: string | (() => string);
};

/** Poll until `check` holds. A number is shorthand for `{ timeoutMs }`. */
export async function until(check: () => boolean | Promise<boolean>, options: number | Options = {}): Promise<void> {
  const { timeoutMs, attempts, intervalMs = 5, message = 'Condition timed out' } = typeof options === 'number' ? { timeoutMs: options } : options;
  const end = Date.now() + (timeoutMs ?? (attempts === undefined ? 10_000 : Infinity));
  for (let attempt = 0; !await check(); attempt++) {
    if (Date.now() > end || attempts !== undefined && attempt >= attempts) throw new Error(typeof message === 'function' ? message() : message);
    await delay(intervalMs);
  }
}
