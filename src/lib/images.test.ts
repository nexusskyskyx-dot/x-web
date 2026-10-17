import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runImageSearch, ImageAuthError, ImageRequestError } from './images.ts';

function mockFetch(payload: unknown, status = 200) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const req = () => new Request('https://x.test/api/v1/images', { method: 'POST' });

describe('image search adapters', () => {
  test('Brave sends image search params and normalizes metadata', async () => {
    const mocked = mockFetch({
      results: [{
        title: 'Purple flower',
        url: 'https://example.com/gallery',
        source: 'example.com',
        page_fetched: '2026-09-10T12:00:00Z',
        thumbnail: { src: 'https://thumb.example/purple.jpg', width: 300, height: 200 },
        properties: { url: 'https://images.example/purple.jpg', width: 1800, height: 1200 },
      }],
    });
    try {
      const result = await runImageSearch(req(), { query: 'purple flower', provider: 'brave', api_key: 'BSA-test', max_results: 7 });
      assert.equal(mocked.calls.length, 1);
      assert.match(mocked.calls[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/images\/search/);
      const url = new URL(mocked.calls[0].url);
      assert.equal(url.searchParams.get('q'), 'purple flower');
      assert.equal(url.searchParams.get('count'), '7');
      assert.equal(url.searchParams.get('safesearch'), 'strict');
      assert.equal((mocked.calls[0].init?.headers as Record<string, string>)['X-Subscription-Token'], 'BSA-test');
      assert.equal(result.object, 'image_search');
      assert.equal(result.results[0].image_url, 'https://images.example/purple.jpg');
      assert.equal(result.results[0].thumbnail_url, 'https://thumb.example/purple.jpg');
      assert.equal(result.results[0].page_url, 'https://example.com/gallery');
      assert.equal(result.results[0].width, 1800);
      assert.equal(result.results[0].height, 1200);
      assert.equal(result.results[0].alt_text, 'Purple flower');
    } finally { mocked.restore(); }
  });

  test('Serper uses its images endpoint and maps its field names', async () => {
    const mocked = mockFetch({ images: [{
      title: 'Mountain lake', imageUrl: 'https://img.example/lake.jpg',
      thumbnailUrl: 'https://thumb.example/lake.jpg', imageWidth: 1600, imageHeight: 900,
      source: 'Example', domain: 'example.com', link: 'https://example.com/lake', position: 2,
    }] });
    try {
      const result = await runImageSearch(req(), { query: 'mountain lake', provider: 'serper', api_key: 'serper-key', safe_search: 'strict' });
      assert.equal(mocked.calls[0].url, 'https://google.serper.dev/images');
      assert.equal(mocked.calls[0].init?.method, 'POST');
      assert.equal(JSON.parse(mocked.calls[0].init?.body as string).q, 'mountain lake');
      assert.equal(result.results[0].image_url, 'https://img.example/lake.jpg');
      assert.equal(result.results[0].thumbnail_url, 'https://thumb.example/lake.jpg');
      assert.equal(result.results[0].page_url, 'https://example.com/lake');
      assert.deepEqual(result.unsupported_params, ['safe_search']);
    } finally { mocked.restore(); }
  });

  test('never returns executable or malformed image URLs', async () => {
    const mocked = mockFetch({ results: [
      { title: 'bad', properties: { url: 'javascript:alert(1)' }, thumbnail: { src: 'data:image/png;base64,abc' } },
      { title: 'good', properties: { url: 'https://img.example/good.png' }, thumbnail: { src: 'https://thumb.example/good.png' } },
    ] });
    try {
      const result = await runImageSearch(req(), { query: 'test', provider: 'brave', api_key: 'key' });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].image_url, 'https://img.example/good.png');
    } finally { mocked.restore(); }
  });

  test('requires a key and validates provider and safe search', async () => {
    await assert.rejects(() => runImageSearch(req(), { query: 'cats', provider: 'brave' }), ImageAuthError);
    await assert.rejects(() => runImageSearch(req(), { query: 'cats', provider: 'tavily', api_key: 'key' }), ImageRequestError);
    await assert.rejects(() => runImageSearch(req(), { query: 'cats', safe_search: 'moderate', api_key: 'key' }), ImageRequestError);
    await assert.rejects(() => runImageSearch(req(), { query: '' }), ImageRequestError);
  });

  test('surfaces upstream HTTP errors', async () => {
    const mocked = mockFetch({ message: 'bad key' }, 401);
    try {
      await assert.rejects(() => runImageSearch(req(), { query: 'cats', provider: 'brave', api_key: 'bad' }), (error: any) => {
        assert.equal(error.status, 401);
        assert.equal(error.provider, 'brave');
        return true;
      });
    } finally { mocked.restore(); }
  });
});
