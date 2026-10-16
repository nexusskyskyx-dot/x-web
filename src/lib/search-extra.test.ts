import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePublishedDate,
  rankByFreshness,
  unsupportedParams,
  PROVIDER_CAPABILITIES,
  type SearchHit,
} from './search.ts';

describe('published date normalisation', () => {
  test('passes ISO dates through', () => {
    assert.equal(normalizePublishedDate('2025-03-04T10:00:00Z'), '2025-03-04T10:00:00.000Z');
  });

  test('converts relative dates to absolute ISO', () => {
    const threeDays = normalizePublishedDate('3 days ago');
    assert.ok(threeDays, 'expected a date');
    const ageMs = Date.now() - new Date(threeDays).getTime();
    const days = ageMs / 86_400_000;
    assert.ok(days > 2.9 && days < 3.1, `expected ~3 days, got ${days}`);
  });

  test('parses textual dates', () => {
    const parsed = normalizePublishedDate('Dec 18, 2022');
    assert.ok(parsed?.startsWith('2022-12-18'), `got ${parsed}`);
  });

  test('rejects nonsense and absurd years', () => {
    assert.equal(normalizePublishedDate(''), undefined);
    assert.equal(normalizePublishedDate('not a date'), undefined);
    assert.equal(normalizePublishedDate('1899-01-01'), undefined);
    assert.equal(normalizePublishedDate(undefined), undefined);
    assert.equal(normalizePublishedDate(42), undefined);
  });
});

describe('freshness ranking', () => {
  const hits: SearchHit[] = [
    { title: 'old', url: 'https://a.com', snippet: 'a', published_date: '2020-01-01T00:00:00.000Z' },
    { title: 'fresh', url: 'https://b.com', snippet: 'b', published_date: new Date().toISOString() },
    { title: 'undated', url: 'https://c.com', snippet: 'c' },
  ];

  test('promotes recent results within the window', () => {
    const ranked = rankByFreshness(hits, 'week');
    assert.equal(ranked[0].title, 'fresh');
  });

  test('leaves undated and stale results after fresh ones', () => {
    const ranked = rankByFreshness(hits, 'week');
    const order = ranked.map((h) => h.title);
    assert.ok(order.indexOf('fresh') < order.indexOf('old'));
    assert.ok(order.indexOf('fresh') < order.indexOf('undated'));
  });

  test('does not reorder when nothing falls inside the window', () => {
    const stale: SearchHit[] = [
      { title: 'one', url: 'https://a.com', snippet: 'a', published_date: '2020-01-01T00:00:00.000Z' },
      { title: 'two', url: 'https://b.com', snippet: 'b', published_date: '2019-01-01T00:00:00.000Z' },
    ];
    const ranked = rankByFreshness(stale, 'day');
    assert.deepEqual(ranked.map((h) => h.title), ['one', 'two']);
  });
});

describe('provider capabilities', () => {
  test('reports params a provider cannot honour', () => {
    // Exa ignores language and country.
    const dropped = unsupportedParams({ query: 'x', language: 'es', country: 'ES' }, 'exa');
    assert.ok(dropped.includes('language'));
    assert.ok(dropped.includes('country'));
  });

  test('reports nothing when the provider supports everything asked for', () => {
    const dropped = unsupportedParams(
      { query: 'x', time_range: 'week', language: 'de', country: 'DE' },
      'brave',
    );
    assert.deepEqual(dropped, []);
  });

  test('brave cannot return raw page content', () => {
    assert.equal(PROVIDER_CAPABILITIES.brave.rawContent, false);
    assert.ok(
      unsupportedParams({ query: 'x', include_raw_content: true }, 'brave').includes(
        'include_raw_content',
      ),
    );
  });

  test('tavily cannot filter by language', () => {
    assert.equal(PROVIDER_CAPABILITIES.tavily.language, false);
  });

  test('every provider declares a full capability set', () => {
    for (const [id, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
      for (const key of ['timeRange', 'language', 'country', 'answer', 'rawContent', 'domainFilter']) {
        assert.equal(typeof (caps as any)[key], 'boolean', `${id}.${key} must be a boolean`);
      }
      assert.ok(caps.maxResults > 0);
    }
  });
});
