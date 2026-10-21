import assert from 'node:assert/strict';
import test from 'node:test';
import { requestHandler, vercelRequest } from '../src/http';

test('unconfigured account routes fail closed without exposing configuration', async () => {
  const handle = requestHandler({
    NODE_ENV: 'production',
    JUICED_SERVICE_URL: 'https://juiced.codes',
  });
  for (const path of ['/ready', '/v1/config', '/api/auth/get-session', '/webhooks/stripe']) {
    const response = await handle(new Request(`https://juiced.codes${path}`));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-juiced-error'), '1');
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  }
  const response = await handle(new Request('https://juiced.codes/sign-in'));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Account access is not available yet/);
  assert.equal((await handle(new Request('https://juiced.codes/health'))).status, 200);
});

test('only Vercel ingress can supply the private rate-limit identity', async () => {
  const request = new Request('https://juiced.codes/api/auth/sign-in/social', {
    method: 'POST',
    headers: {
      'x-juiced-peer-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8',
      'x-vercel-forwarded-for': '203.0.113.10',
    },
    body: 'preserve this body',
  });
  assert.equal(vercelRequest(request.clone(), {}).headers.get('x-juiced-peer-ip'), null);
  const forwarded = vercelRequest(request.clone(), { VERCEL: '1' });
  assert.equal(forwarded.headers.get('x-juiced-peer-ip'), '203.0.113.10');
  assert.equal(await forwarded.text(), 'preserve this body');
  request.headers.set('x-vercel-forwarded-for', '1.2.3.4, 203.0.113.10');
  assert.equal(
    vercelRequest(request.clone(), { VERCEL: '1' }).headers.get('x-juiced-peer-ip'),
    null,
  );
  request.headers.set('x-vercel-forwarded-for', '2001:db8::1');
  assert.equal(
    vercelRequest(request.clone(), { VERCEL: '1' }).headers.get('x-juiced-peer-ip'),
    '2001:db8::1',
  );
});
