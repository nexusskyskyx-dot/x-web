import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchAcrossProviders } from './federation.ts';
import { SearchError } from './search.ts';

function mockFetch(respond: (url: string, init?: RequestInit) => { body: unknown; status?: number }) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const response = respond(url, init);
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const request = { query: 'MCP protocol', max_results: 5, include_answer: true };

describe('provider federation', () => {
  test('fans out in parallel, blends, deduplicates, and preserves provenance', async () => {
    const mocked = mockFetch((url) => url.includes('tavily')
      ? { body: { answer: 'MCP answer', results: [{ title: 'MCP protocol guide', url: 'https://example.com/mcp?utm_source=one', content: 'The MCP protocol connects AI agents to tools.', score: 0.9 }] } }
      : { body: { web: { results: [{ title: 'MCP protocol guide', url: 'https://www.example.com/mcp/', description: 'The MCP protocol connects AI agents to tools.' }] } } });
    try {
      const result = await searchAcrossProviders(request, {
        primaryProvider: 'tavily', primaryKey: 'tvly-primary', multiSource: true,
        providerKeys: { brave: 'brave-key' },
      });
      assert.equal(mocked.calls.length, 2);
      assert.equal(result.provider, 'multi');
      assert.deepEqual(result.providers_used, ['tavily', 'brave']);
      assert.equal(result.answer, 'MCP answer');
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].source_count, 2);
      assert.deepEqual((result.results[0].providers ?? []).sort(), ['brave', 'tavily']);
    } finally { mocked.restore(); }
  });

  test('single-source mode honors the chosen provider even when more keys exist', async () => {
    const mocked = mockFetch(() => ({ body: { results: [] } }));
    try {
      const result = await searchAcrossProviders(request, {
        primaryProvider: 'brave', primaryKey: 'brave-primary', multiSource: false,
        providerKeys: { tavily: 'tvly-key' },
      });
      assert.equal(mocked.calls.length, 1);
      assert.match(mocked.calls[0].url, /brave/);
      assert.equal(result.provider, 'brave');
      assert.deepEqual(result.providers_used, ['brave']);
    } finally { mocked.restore(); }
  });

  test('keeps XWEB_API_BASE forwarding to one upstream x-web call', async () => {
    const mocked = mockFetch(() => ({ body: { provider: 'tavily', results: [{ title: 'MCP', url: 'https://example.com/mcp', snippet: 'The MCP protocol.' }] } }));
    try {
      const result = await searchAcrossProviders(request, {
        apiBase: 'https://api.example.test/v1',
        primaryProvider: 'tavily', primaryKey: 'xweb-key', multiSource: true,
        providerKeys: { brave: 'raw-brave-key' },
        requestedProviders: ['tavily', 'brave'],
      });
      assert.equal(mocked.calls.length, 1);
      assert.equal(result.provider, 'tavily');
      assert.deepEqual(result.providers_used, ['tavily']);
    } finally { mocked.restore(); }
  });

  test('returns good providers when another source fails', async () => {
    const mocked = mockFetch((url) => url.includes('tavily')
      ? { body: { results: [{ title: 'MCP protocol', url: 'https://example.com/mcp', content: 'The MCP protocol connects agents.' }] } }
      : { body: { message: 'upstream down' }, status: 503 });
    try {
      const result = await searchAcrossProviders(request, {
        primaryProvider: 'tavily', primaryKey: 'tvly-key', multiSource: true,
        providerKeys: { brave: 'brave-key' },
      });
      assert.deepEqual(result.providers_used, ['tavily']);
      assert.equal(result.provider_errors?.length, 1);
      assert.equal(result.provider_errors?.[0].provider, 'brave');
      assert.equal(result.results.length, 1);
    } finally { mocked.restore(); }
  });

  test('fails as a client error when no allow-listed provider has a key', async () => {
    await assert.rejects(
      () => searchAcrossProviders(request, {
        primaryProvider: 'tavily', primaryKey: 'tvly-key', multiSource: true,
        requestedProviders: ['brave'],
      }),
      (error: unknown) => error instanceof SearchError && error.status === 400,
    );
  });

  test('reports requested providers that have no configured key', async () => {
    const mocked = mockFetch(() => ({ body: { results: [] } }));
    try {
      const result = await searchAcrossProviders(request, {
        primaryProvider: 'tavily', primaryKey: 'tvly-key', multiSource: true,
        requestedProviders: ['tavily', 'exa'],
      });
      assert.deepEqual(result.unavailable_providers, ['exa']);
      assert.deepEqual(result.providers_used, ['tavily']);
    } finally { mocked.restore(); }
  });
});
