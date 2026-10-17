import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { understandQuery, mergeIntentWithRequest, isTimeRange } from './intent.ts';

describe('query understanding', () => {
  test('classifies a definition question and strips the scaffolding', () => {
    const intent = understandQuery('What is the Model Context Protocol?');

    assert.equal(intent.type, 'definition');
    assert.ok(intent.confidence > 0.6, `expected confidence > 0.6, got ${intent.confidence}`);
    assert.ok(intent.keywords.includes('model'), `keywords were ${intent.keywords.join(', ')}`);
    // "what is the" is scaffolding an index cannot use
    assert.ok(!/\bwhat\b|\bis\b|\bthe\b/.test(intent.rewritten_query));
    assert.ok(intent.signals.includes('definition_phrase'));
  });

  test('detects recency and turns it into a time filter', () => {
    const intent = understandQuery('latest news on the MCP spec');

    assert.equal(intent.type, 'news');
    assert.equal(intent.time_sensitive, true);
    assert.equal(intent.filters.topic, 'news');
    assert.equal(intent.filters.time_range, 'week');
  });

  test('tightens the window for "today"', () => {
    const intent = understandQuery('what happened in AI today');
    assert.equal(intent.filters.time_range, 'day');
    assert.equal(intent.time_sensitive, true);
  });

  test('classifies comparison, howto, code, shopping and navigational', () => {
    assert.equal(understandQuery('Tailwind vs Bootstrap for a docs site').type, 'comparison');
    assert.equal(understandQuery('how to deploy Astro to Vercel').type, 'howto');
    assert.equal(understandQuery('TypeError: cannot read property of undefined').type, 'code');
    assert.equal(understandQuery('best noise cancelling headphones under $300').type, 'shopping');
    assert.equal(understandQuery('astro build docs login page').type, 'navigational');
  });

  test('extracts entities including money and versions', () => {
    const intent = understandQuery('best headphones under $300 in 2025 with v2.1 firmware');
    const types = intent.entities.map((e) => e.type);

    assert.ok(types.includes('money'), `entities: ${JSON.stringify(intent.entities)}`);
    assert.ok(types.includes('year'));
    assert.ok(types.includes('version'));
  });

  test('parses site: operators into domain filters', () => {
    const intent = understandQuery('astro routing site:docs.astro.build -site:reddit.com');
    assert.deepEqual(intent.filters.include_domains, ['docs.astro.build']);
    assert.deepEqual(intent.filters.exclude_domains, ['reddit.com']);
  });

  test('infers a country from phrasing', () => {
    assert.equal(understandQuery('best coffee shops in Japan').filters.country, 'JP');
    assert.equal(understandQuery('developer jobs in Germany').filters.country, 'DE');
  });

  test('detects non-English queries', () => {
    const spanish = understandQuery('¿Qué es el protocolo de contexto de modelo?');
    assert.equal(spanish.language.language, 'es');

    const japanese = understandQuery('モデルコンテキストプロトコルとは何ですか');
    assert.equal(japanese.language.language, 'ja');

    const french = understandQuery('Comment déployer une application sur Vercel');
    assert.equal(french.language.language, 'fr');
  });

  test('never rewrites a query into something emptier than the original', () => {
    for (const query of ['MCP', 'astro', 'what is the model context protocol', '¿Qué es MCP?']) {
      const intent = understandQuery(query);
      assert.ok(
        intent.rewritten_query.length > 0,
        `rewrote "${query}" to an empty string`,
      );
    }
  });

  test('a bare keyword query is not treated as a question', () => {
    const intent = understandQuery('astro vercel adapter');
    assert.equal(intent.type, 'search');
    assert.equal(intent.time_sensitive, false);
    assert.equal(intent.filters.topic, undefined);
  });

  test('empty input degrades gracefully', () => {
    const intent = understandQuery('   ');
    assert.equal(intent.type, 'search');
    assert.equal(intent.confidence, 0);
    assert.deepEqual(intent.signals, ['empty_query']);
  });
});

describe('mergeIntentWithRequest', () => {
  test('explicit request parameters override inference', () => {
    const intent = understandQuery('latest news on MCP');
    const merged = mergeIntentWithRequest(intent, { topic: 'general', time_range: 'year' });

    assert.equal(intent.filters.topic, 'news');
    assert.equal(merged.topic, 'general');
    assert.equal(merged.time_range, 'year');
  });

  test('inference fills gaps the caller left open', () => {
    const intent = understandQuery('what happened in AI this week');
    const merged = mergeIntentWithRequest(intent, {});

    assert.equal(merged.time_range, 'week');
  });

  test('domain filters from both sources are combined', () => {
    const intent = understandQuery('astro site:docs.astro.build');
    const merged = mergeIntentWithRequest(intent, { include_domains: ['example.com'] });

    assert.deepEqual(merged.include_domains?.sort(), ['docs.astro.build', 'example.com']);
  });

  test('isTimeRange validates the four known windows', () => {
    assert.equal(isTimeRange('day'), true);
    assert.equal(isTimeRange('year'), true);
    assert.equal(isTimeRange('decade'), false);
    assert.equal(isTimeRange(undefined), false);
  });
});
