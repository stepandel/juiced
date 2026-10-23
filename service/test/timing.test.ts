import assert from 'node:assert/strict';
import test from 'node:test';
import { timed, withRequestTiming } from '../src/timing';
import { requestHandler } from '../src/http';

const traced = () => new Request('https://juiced.example/test', { headers: { 'X-Juiced-Timing': '1' } });

test('timing scopes isolate concurrent requests and preserve streamed response ownership', async () => {
  let cancelled = false;
  const first = withRequestTiming(traced(), async () => {
    await timed('fleet_connection', async () => { await new Promise(resolve => setImmediate(resolve)); });
    // Nested application scopes must not lose the outer HTTP initialization metric.
    return withRequestTiming(traced(), async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')); },
      cancel() { cancelled = true; },
    }), { status: 201, headers: { 'X-Request-ID': 'retained' } }));
  });
  const second = withRequestTiming(traced(), async () => {
    await timed('auth', async () => {});
    return new Response('second');
  });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 201);
  assert.equal(a.headers.get('x-request-id'), 'retained');
  assert.match(a.headers.get('server-timing')!, /fleet_connection;dur=\d+\.\d/);
  assert.doesNotMatch(a.headers.get('server-timing')!, /auth;/);
  assert.match(b.headers.get('server-timing')!, /auth;dur=\d+\.\d/);
  assert.doesNotMatch(b.headers.get('server-timing')!, /fleet_connection/);
  const reader = a.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first chunk');
  assert.equal(cancelled, false);
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('unrequested timing leaves responses unchanged and failed phases retain their original error', async () => {
  const original = new Response('plain');
  assert.equal(await withRequestTiming(new Request('https://juiced.example/test'), async () => {
    await timed('auth', async () => {});
    return original;
  }), original);
  assert.equal(original.headers.get('server-timing'), null);
  const failure = new Error('original failure');
  const response = await withRequestTiming(traced(), async () => {
    await assert.rejects(timed('auth', async () => { throw failure; }), error => error === failure);
    return Response.json({ error: 'failed' }, { status: 401 });
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('server-timing')!, /auth;dur=/);
});

test('HTTP failures retain the service initialization timing without exposing configuration', async () => {
  const response = await requestHandler({ NODE_ENV: 'production', JUICED_SERVICE_URL: 'https://juiced.example' })(new Request('https://juiced.example/v1/config', { headers: { 'X-Juiced-Timing': '1' } }));
  assert.equal(response.status, 503);
  assert.match(response.headers.get('server-timing')!, /^service_init;dur=\d+\.\d, service_total;dur=\d+\.\d$/);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});
