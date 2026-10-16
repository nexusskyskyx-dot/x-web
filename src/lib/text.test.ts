import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, isNearDuplicate, keywords, splitSentences, termCoverage, truncateChars } from './text.ts';

describe('text primitives', () => {
  test('tokenizes Unicode and folds accents', () => {
    assert.deepEqual(keywords('¿Qué es la búsqueda web?'), ['busqueda', 'web']);
  });

  test('splits sentences without splitting decimal numbers or abbreviations', () => {
    assert.deepEqual(
      splitSentences('Dr. Ada used version 2.1. It worked. Then it shipped!'),
      ['Dr. Ada used version 2.1.', 'It worked.', 'Then it shipped!'],
    );
  });

  test('scores query-term coverage between zero and one', () => {
    assert.equal(termCoverage('MCP protocol', 'The MCP protocol connects tools.'), 1);
    assert.equal(termCoverage('MCP protocol', 'A sourdough starter leavens bread.'), 0);
  });

  test('detects near-duplicate snippets', () => {
    assert.equal(isNearDuplicate('The Model Context Protocol connects AI apps to tools.', 'The Model Context Protocol connects AI apps to tools.'), true);
    assert.equal(isNearDuplicate('completely different short text', 'unrelated'), false);
  });

  test('cleans common HTML entities and safely handles invalid numeric entities', () => {
    assert.equal(cleanText('A&nbsp;&amp; B &mdash; &#99999999;'), 'A & B — �');
  });

  test('truncates at a word boundary', () => {
    const result = truncateChars('A sentence with useful words at the end.', 20);
    assert.ok(result.length <= 21);
    assert.ok(result.endsWith('…'));
    assert.ok(!result.includes('useful words at'));
  });
});
