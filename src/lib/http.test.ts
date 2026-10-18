import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BodyError, readJsonBody, searchParamsToBody, resolveKey } from './http.ts';

describe('HTTP request helpers', () => {
  test('reads a JSON object', async () => {
    const request = new Request('https://x.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello', max_results: 5 }),
    });
    assert.deepEqual(await readJsonBody(request), { query: 'hello', max_results: 5 });
  });

  test('rejects malformed JSON, primitives, arrays and oversized bodies', async () => {
    for (const body of ['{bad', 'null', '[]', JSON.stringify({ data: 'x'.repeat(1_000_001) })]) {
      const request = new Request('https://x.test/api', { method: 'POST', body });
      await assert.rejects(() => readJsonBody(request), BodyError);
    }
  });

  test('accepts JSON without a content-type for forgiving clients', async () => {
    const request = new Request('https://x.test/api', { method: 'POST', body: '{"query":"hi"}' });
    assert.deepEqual(await readJsonBody(request), { query: 'hi' });
  });

  test('parses simple GET search options and comma-separated arrays', () => {
    const body = searchParamsToBody(
      new URL('https://x.test/api?q=latest+MCP&mode=deep&max_results=3&time_range=week&include_answer=false&multi_source=0&providers=brave,exa&include_domains=a.com,b.com'),
    );
    assert.deepEqual(body, {
      query: 'latest MCP',
      max_results: 3,
      time_range: 'week',
      include_answer: false,
      mode: 'deep',
      multi_source: false,
      providers: ['brave', 'exa'],
      include_domains: ['a.com', 'b.com'],
    });
  });

  test('resolves a provider-specific server key for an explicitly selected provider', () => {
    const names = ['XWEB_SEARCH_PROVIDER', 'XWEB_SEARCH_API_KEY', 'BRAVE_API_KEY'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      delete process.env.XWEB_SEARCH_PROVIDER;
      delete process.env.XWEB_SEARCH_API_KEY;
      process.env.BRAVE_API_KEY = 'brave-server-key';
      const resolution = resolveKey(new Request('https://x.test'), { provider: 'brave' });
      assert.equal(resolution.key, 'brave-server-key');
      assert.equal(resolution.provider, 'brave');
      assert.equal(resolution.source, 'server');
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('resolves credentials in header → body → server order', () => {
    const header = resolveKey(
      new Request('https://x.test', { headers: { 'x-xweb-key': 'header-key' } }),
      { api_key: 'body-key', provider: 'brave' },
    );
    assert.equal(header.key, 'header-key');
    assert.equal(header.provider, 'brave');
    assert.equal(header.source, 'header');

    const body = resolveKey(new Request('https://x.test'), { api_key: 'body-key', provider: 'exa' });
    assert.equal(body.key, 'body-key');
    assert.equal(body.provider, 'exa');
    assert.equal(body.source, 'body');

    const none = resolveKey(new Request('https://x.test'), {});
    assert.equal(none.key, '');
    assert.equal(none.source, 'none');
  });
});
