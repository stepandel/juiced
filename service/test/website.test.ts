import assert from 'node:assert/strict';
import test from 'node:test';
import app from '../../server.js';
import { website, vercelRequest } from '../src/website.js';

test('the Vercel entry point serves the public site without account infrastructure', async () => {
  const response = await app.request('https://juiced.codes/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/html/);
  assert.match(response.headers.get('content-security-policy')!, /script-src 'none'/);
  const html = await response.text();
  assert.match(html, /Claude Code,/);
  assert.match(html, /Private preview/);
  assert.doesNotMatch(html, /npm (install|i) (?:-g )?juiced/);
  assert.deepEqual(await (await app.request('https://juiced.codes/health')).json(), { status: 'ok' });
  assert.equal((await app.request('https://juiced.codes/unknown')).status, 404);
});

test('unconfigured account routes fail closed without exposing configuration', async t => {
  t.mock.method(console, 'error', () => {});
  const app = website({ NODE_ENV: 'production', JUICED_SERVICE_URL: 'https://juiced.codes' });
  for (const path of ['/ready', '/v1/config', '/api/auth/get-session', '/webhooks/stripe']) {
    const response = await app.request(`https://juiced.codes${path}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-juiced-error'), '1');
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  }
  const response = await app.request('https://juiced.codes/sign-in');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Account access is not available yet/);
  assert.equal((await app.request('https://juiced.codes/')).status, 200);
});

test('only Vercel ingress can supply the private rate-limit identity', async () => {
  const request = new Request('https://juiced.codes/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'x-juiced-peer-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8', 'x-vercel-forwarded-for': '203.0.113.10' },
    body: 'preserve this body',
  });
  assert.equal(vercelRequest(request.clone(), {}).headers.get('x-juiced-peer-ip'), null);
  const forwarded = vercelRequest(request.clone(), { VERCEL: '1' });
  assert.equal(forwarded.headers.get('x-juiced-peer-ip'), '203.0.113.10');
  assert.equal(await forwarded.text(), 'preserve this body');
  request.headers.set('x-vercel-forwarded-for', '1.2.3.4, 203.0.113.10');
  assert.equal(vercelRequest(request.clone(), { VERCEL: '1' }).headers.get('x-juiced-peer-ip'), null);
  request.headers.set('x-vercel-forwarded-for', '2001:db8::1');
  assert.equal(vercelRequest(request.clone(), { VERCEL: '1' }).headers.get('x-juiced-peer-ip'), '2001:db8::1');
});
