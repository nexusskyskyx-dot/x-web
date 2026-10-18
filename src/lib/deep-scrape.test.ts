import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepScrapePages } from './deep-scrape.ts';

test('uses Firecrawl browser actions with the supplied BYOK credential', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  let body: any;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      success: true,
      data: { markdown: '# Expanded page\n\nLazy-loaded FAQ text.', metadata: { title: 'Expanded title', language: 'en' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const pages = await deepScrapePages(['https://8.8.8.8/article'], 'firecrawl-user-key');
    assert.equal(requestUrl, 'https://api.firecrawl.dev/v2/scrape');
    assert.equal(new Headers(requestHeaders).get('authorization'), 'Bearer firecrawl-user-key');
    assert.equal(body.url, 'https://8.8.8.8/article');
    assert.equal(body.onlyMainContent, true);
    assert.ok(body.actions.some((action: any) => action.type === 'click'));
    assert.ok(body.actions.some((action: any) => action.type === 'scroll'));
    assert.equal(pages[0].title, 'Expanded title');
    assert.equal(pages[0].text, '# Expanded page\n\nLazy-loaded FAQ text.');
  } finally { globalThis.fetch = originalFetch; }
});

test('rejects local network targets before asking Firecrawl to fetch them', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const pages = await deepScrapePages(['http://127.0.0.1/admin'], 'firecrawl-user-key');
    assert.equal(calls, 0);
    assert.match(pages[0].error ?? '', /private|reserved/i);
  } finally { globalThis.fetch = originalFetch; }
});
