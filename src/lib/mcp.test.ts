import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIContext } from 'astro';
import { OPTIONS, POST } from '../pages/api/mcp.ts';

function context(method: string, headers: HeadersInit = {}): APIContext {
  return {
    request: new Request('https://x-web.example/api/mcp', { method, headers }),
    clientAddress: '203.0.113.8',
  } as APIContext;
}

test('remote MCP endpoint', async (t) => {
  await t.test('supports CORS preflight without requiring a key', async () => {
    const response = await OPTIONS(context('OPTIONS'));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  });

  await t.test('requires an x-web account key before starting MCP', async () => {
    const response = await POST(context('POST', { 'content-type': 'application/json' }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    const payload = await response.json();
    assert.equal(payload.error.code, 'missing_api_key');
  });
});
