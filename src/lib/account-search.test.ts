import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIContext } from 'astro';
import { POST } from '../pages/api/account/search.ts';

test('dashboard account search', async () => {
  const context = {
    request: new Request('https://x-web.example/api/account/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'test', mode: 'standard' }),
    }),
    clientAddress: '198.51.100.217',
  } as APIContext;
  const response = await POST(context);
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error.code, 'missing_session');
});
