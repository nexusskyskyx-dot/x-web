import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch, SearchError, isProvider, type SearchRequest } from './search.ts';

type FetchCall = { url: string; init: RequestInit };

function mockFetch(response: unknown, status = 200) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

const base: SearchRequest = { query: 'astro v7 release notes', max_results: 3 };

describe('provider adapters', () => {
  test('tavily posts the right body and normalises the response', async () => {
    const calls = mockFetch({
      query: 'astro v7 release notes',
      answer: 'Astro 7.4.0 ships with Vite 8.',
      results: [
        {
          title: 'Upgrade to Astro v7',
          url: 'https://docs.astro.build/en/guides/upgrade-to/v7/',
          content: 'Astro v7.0 upgrades to Vite 8.',
          score: 0.98,
        },
      ],
    });

    const result = await runSearch('tvly-key', {
      ...base,
      provider: 'tavily',
      include_domains: ['docs.astro.build'],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.tavily.com/search');
    assert.equal(calls[0].init.method, 'POST');

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tvly-key');

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.query, 'astro v7 release notes');
    assert.equal(body.max_results, 3);
    assert.deepEqual(body.include_domains, ['docs.astro.build']);

    assert.equal(result.provider, 'tavily');
    assert.equal(result.answer, 'Astro 7.4.0 ships with Vite 8.');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'https://docs.astro.build/en/guides/upgrade-to/v7/');
    assert.equal(result.results[0].snippet, 'Astro v7.0 upgrades to Vite 8.');
    assert.equal(result.results[0].score, 0.98);
  });

  test('brave uses a GET with a subscription token and site: operators', async () => {
    const calls = mockFetch({
      web: {
        results: [
          { title: 'Astro', url: 'https://astro.build/', description: 'The web framework' },
        ],
      },
    });

    const result = await runSearch('BSA-key', {
      ...base,
      provider: 'brave',
      include_domains: ['astro.build'],
      exclude_domains: ['spam.example'],
    });

    assert.equal(calls[0].url.startsWith('https://api.search.brave.com/res/v1/web/search?'), true);
    assert.equal(calls[0].init.method, undefined);

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Subscription-Token'], 'BSA-key');

    const query = new URL(calls[0].url).searchParams.get('q') ?? '';
    assert.match(query, /site:astro\.build/);
    assert.match(query, /-site:spam\.example/);

    assert.equal(result.results[0].snippet, 'The web framework');
  });

  test('serper maps organic results and answer boxes', async () => {
    const calls = mockFetch({
      answerBox: {
        title: 'Astro',
        link: 'https://astro.build/',
        answer: 'A web framework for content-driven websites.',
      },
      organic: [
        {
          title: 'Astro Docs',
          link: 'https://docs.astro.build/',
          snippet: 'Docs',
          date: '2026-09-01',
        },
      ],
    });

    const result = await runSearch('serper-key', { ...base, provider: 'serper' });

    assert.equal(calls[0].url, 'https://google.serper.dev/search');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-API-KEY'], 'serper-key');

    assert.equal(result.answer, 'A web framework for content-driven websites.');
    // The answer box is promoted to the top of the result list.
    assert.equal(result.results[0].url, 'https://astro.build/');
    assert.equal(result.results[1].url, 'https://docs.astro.build/');
    assert.equal(result.results[1].published_date, '2026-09-01');
  });

  test('exa sends includeDomains natively and maps the text field', async () => {
    const calls = mockFetch({
      results: [
        {
          title: 'Astro',
          url: 'https://astro.build/',
          text: 'A web framework for content-driven websites.',
          score: 0.9,
          publishedDate: '2026-09-01',
        },
      ],
    });

    const result = await runSearch('exa-key', {
      ...base,
      provider: 'exa',
      include_domains: ['astro.build'],
    });

    assert.equal(calls[0].url, 'https://api.exa.ai/search');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'exa-key');

    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body.includeDomains, ['astro.build']);
    assert.equal(body.numResults, 3);

    assert.equal(result.results[0].snippet, 'A web framework for content-driven websites.');
    assert.equal(result.results[0].score, 0.9);
  });

  test('upstream failures surface as SearchError with the provider status', async () => {
    mockFetch({ error: { message: 'Invalid key' } }, 401);

    await assert.rejects(
      () => runSearch('bad-key', { ...base, provider: 'tavily' }),
      (error: unknown) => {
        assert.ok(error instanceof SearchError);
        assert.equal(error.status, 401);
        assert.equal(error.provider, 'tavily');
        assert.match(error.message, /rejected by the provider/);
        return true;
      },
    );
  });

  test('an x-web deployment is called instead of a provider when apiBase is set', async () => {
    const calls = mockFetch({
      id: 'xweb_1',
      query: 'astro v7 release notes',
      provider: 'x-web',
      results: [{ title: 'A', url: 'https://a.dev', snippet: 'x' }],
      took_ms: 120,
    });

    const result = await runSearch(
      'xw_live_key',
      { ...base },
      { apiBase: 'https://api.x-web.dev/v1' },
    );

    assert.equal(calls[0].url, 'https://api.x-web.dev/v1/search');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer xw_live_key');
    assert.equal(result.provider, 'x-web');
    assert.equal(result.took_ms, 120);
  });
});

describe('helpers', () => {
  test('isProvider only accepts known providers', () => {
    assert.equal(isProvider('tavily'), true);
    assert.equal(isProvider('brave'), true);
    assert.equal(isProvider('serper'), true);
    assert.equal(isProvider('exa'), true);
    assert.equal(isProvider('duckduckgo'), false);
    assert.equal(isProvider(undefined), false);
  });
});
