/** One JSON line per failure so Vercel log search can filter by event and request. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      level: 'error',
      event,
      ...fields,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    }),
  );
}
