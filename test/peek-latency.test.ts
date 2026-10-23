import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error The diagnostic helper is a standalone JavaScript module.
import { correlatePeekTimings, serviceTiming } from '../scripts/peek-latency-report.mjs';

const startedAt = '2026-10-23T16:24:38.000Z';
const sample = { requests: [
  { command: 'workspace.inspect', startedAt, headersMs: 1000 },
  { command: 'request', messageId: 'msg_expected', startedAt, headersMs: 2100, snapshotMs: 1142 },
] };
const trace = { id: 'req_expected', path: '/commands/request', duration_us: 1806000, messages: [
  { id: 'msg_expected', attempts: [{ spans: [{ name: 'session.receive', started_at: '2026-10-23T16:24:39.543Z', finished_at: '2026-10-23T16:24:40.698Z' }] }] },
] };

test('peek timings correlate by message ID and keep nested durations separate', () => {
  const result = correlatePeekTimings(sample, { requests: [
    { ...trace, id: 'req_unrelated', messages: [{ id: 'msg_other' }] },
    trace,
    { id: 'req_lookup', path: '/commands/workspace.inspect', received_at: startedAt, duration_us: 543000 },
  ] });
  assert.equal(result[0].matchedBy, 'time_window');
  assert.equal(result[0].outsidePlatformMs, 457);
  assert.deepEqual(result[1], { command: 'request', matched: true, matchedBy: 'message_id', traceId: 'req_expected', platformMs: 1806, outsidePlatformMs: 294, attempts: 1, handlerMs: 1155, platformOutsideHandlerMs: 651, snapshotMs: 1142, handlerOutsideSnapshotMs: 13 });
});

test('ambiguous or absent platform traces remain unknown', () => {
  const lookup = { path: '/commands/workspace.inspect', received_at: startedAt, duration_us: 100000 };
  const result = correlatePeekTimings(sample, { requests: [{ ...lookup, id: 'a' }, { ...lookup, id: 'b' }] });
  assert.deepEqual(result, [{ command: 'workspace.inspect', matched: false, candidates: 2 }, { command: 'request', matched: false, candidates: 0 }]);
});

test('clock or timing inconsistencies do not become negative overhead or a false zero', () => {
  const result = correlatePeekTimings({ requests: [{ command: 'request', messageId: 'msg_expected', headersMs: 1000, snapshotMs: 2000 }] }, { requests: [trace] });
  assert.equal(result[0].outsidePlatformMs, null);
  assert.equal(result[0].handlerOutsideSnapshotMs, null);
});

test('service timings retain only known numeric phases', () => {
  assert.deepEqual(serviceTiming('auth;dur=12.1, fleet_connection;dur=235, edge;dur=45.8, auth;dur=0.9, token;dur=1, account;dur=NaN'), { auth: 13, fleet_connection: 235, edge: 45.8 });
  assert.deepEqual(serviceTiming(null), {});
});
