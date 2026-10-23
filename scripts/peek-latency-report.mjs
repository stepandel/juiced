const elapsed = (start, end) => {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
};

/** Ignore descriptions and unknown metric names; retain only fixed numeric phases. */
export function serviceTiming(header) {
  const known = new Set(['auth', 'rate_limit', 'account', 'installation', 'bootstrap', 'job_wake', 'fleet_connection', 'edge', 'service_init', 'service_total']);
  const metrics = {};
  for (const value of (header ?? '').split(',')) {
    const match = /^\s*([a-z_]+);dur=(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (match && known.has(match[1]) && Number.isFinite(Number(match[2]))) metrics[match[1]] = (metrics[match[1]] ?? 0) + Number(match[2]);
  }
  return metrics;
}

/** Prefer exact message IDs; workspace lookups have only a bounded time window. */
export function correlatePeekTimings(sample, document) {
  return sample.requests.filter(request => request.command).map(request => {
    const path = `/commands/${request.command}`;
    const candidates = (document.requests ?? []).filter(trace => {
      if (trace.path !== path) return false;
      if (request.messageId && trace.messages?.some(message => message.id === request.messageId)) return true;
      if (request.command !== 'workspace.inspect') return false;
      const received = Date.parse(trace.received_at), started = Date.parse(request.startedAt);
      // These are different machines' wall clocks. Never choose among ambiguous matches.
      return received >= started - 1000 && received <= started + request.headersMs + 1000;
    });
    if (candidates.length !== 1) return { command: request.command, matched: false, candidates: candidates.length };
    const trace = candidates[0];
    const platformMs = trace.duration_us / 1000;
    const attempts = (trace.messages ?? []).filter(message => message.id === request.messageId).flatMap(message => message.attempts ?? []);
    const handlers = attempts.flatMap(attempt => attempt.spans ?? []).filter(span => span.name === 'session.receive');
    const durations = handlers.map(span => elapsed(span.started_at, span.finished_at));
    const handlerMs = durations.length && durations.every(duration => duration !== null) ? durations.reduce((sum, duration) => sum + duration, 0) : null;
    return {
      command: request.command, matched: true,
      matchedBy: request.command === 'workspace.inspect' ? 'time_window' : 'message_id',
      traceId: trace.id, platformMs,
      outsidePlatformMs: request.headersMs >= platformMs ? Math.round(request.headersMs - platformMs) : null,
      attempts: attempts.length, handlerMs,
      platformOutsideHandlerMs: handlerMs !== null && platformMs >= handlerMs ? Math.round(platformMs - handlerMs) : null,
      snapshotMs: request.snapshotMs ?? null,
      handlerOutsideSnapshotMs: handlerMs !== null && request.snapshotMs !== undefined && handlerMs >= request.snapshotMs ? Math.round(handlerMs - request.snapshotMs) : null,
    };
  });
}
