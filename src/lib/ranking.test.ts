import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authoritySignal, canonicalUrl, rankAndBlend } from './ranking.ts';

describe('best-results ranking', () => {
  test('canonicalizes URLs and removes tracking params', () => {
    assert.equal(
      canonicalUrl('https://www.example.com/article/?utm_source=newsletter&x=1#section'),
      'https://example.com/article?x=1',
    );
  });

  test('uses public, explainable domain authority signals', () => {
    assert.ok(authoritySignal('https://agency.gov/report') > authoritySignal('https://random-blog.com/post'));
    assert.ok(authoritySignal('https://docs.github.com/en') > authoritySignal('https://random-blog.com/post'));
  });

  test('deduplicates the same page across providers and records corroboration', () => {
    const results = rankAndBlend('MCP protocol', [
      { provider: 'brave', results: [
        { title: 'MCP protocol guide', url: 'https://www.example.com/mcp?utm_source=brave', snippet: 'The MCP protocol connects AI agents to tools.', published_date: '2026-10-10T00:00:00Z' },
      ] },
      { provider: 'serper', results: [
        { title: 'MCP protocol guide', url: 'https://example.com/mcp/', snippet: 'The MCP protocol connects AI agents to tools.', published_date: '2026-10-10T00:00:00Z' },
      ] },
    ], { maxResults: 5, now: Date.parse('2026-10-16T00:00:00Z') });

    assert.equal(results.length, 1);
    assert.equal(results[0].source_count, 2);
    assert.deepEqual(results[0].providers.sort(), ['brave', 'serper']);
    assert.ok(results[0].rank_signals.corroboration > 0.3);
    assert.ok(results[0].ranking_score > 0 && results[0].ranking_score <= 1);
  });

  test('combines relevance, freshness and authority into the result order', () => {
    const results = rankAndBlend('official MCP protocol specification', [
      { provider: 'brave', results: [
        { title: 'MCP protocol specification', url: 'https://random-blog.com/mcp', snippet: 'Official MCP protocol specification and standard.', score: 0.9, published_date: '2026-10-15T00:00:00Z' },
        { title: 'MCP protocol specification', url: 'https://agency.gov/mcp', snippet: 'Official MCP protocol specification and standard.', score: 0.9, published_date: '2026-10-15T00:00:00Z' },
      ] },
    ], { maxResults: 2, now: Date.parse('2026-10-16T00:00:00Z') });

    assert.equal(results[0].url, 'https://agency.gov/mcp');
    assert.equal(results[0].rank_signals.authority, 0.98);
    assert.ok(results[0].ranking_score > results[1].ranking_score);
  });

  test('removes near-identical mirrors by title and host while preserving distinct results', () => {
    const results = rankAndBlend('current web search', [
      { provider: 'brave', results: [
        { title: 'Current Web Search Overview and Complete Guide', url: 'https://same.example/a', snippet: 'A guide to current web search.' },
      ] },
      { provider: 'serper', results: [
        { title: 'Current Web Search Overview and Complete Guide', url: 'https://same.example/b', snippet: 'A mirrored guide.' },
        { title: 'Current Web Search: New Results', url: 'https://other.example/new', snippet: 'New results for search.' },
      ] },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.some((item) => item.source_count === 2));
  });
});
