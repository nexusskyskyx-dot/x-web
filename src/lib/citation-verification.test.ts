import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyCitedClaims } from './citation-verification.ts';
import type { AnswerSource } from './answer.ts';

const sources: AnswerSource[] = [
  {
    title: 'MCP overview',
    url: 'https://example.com/mcp',
    snippet: 'Short search snippet.',
    raw_content: 'The Model Context Protocol is an open protocol connecting AI apps with tools and data sources.',
  },
];

test('keeps a citation when its specific scraped page contains matching evidence', () => {
  const result = verifyCitedClaims('The Model Context Protocol is an open protocol for AI apps [1]', sources);
  assert.equal(result.text, 'The Model Context Protocol is an open protocol for AI apps [1]');
  assert.deepEqual(result.indices, [1]);
  assert.deepEqual(result.verification, {
    status: 'supported',
    supported_claims: 1,
    flagged_claims: 0,
    method: 'source_text_overlap',
  });
});

test('removes unsupported references and visibly flags unsupported claims', () => {
  const result = verifyCitedClaims('The Model Context Protocol is an open protocol [1]. Alien crops glow at night [1]', sources);
  assert.equal(result.text, 'The Model Context Protocol is an open protocol [1]. Alien crops glow at night [Unverified]');
  assert.deepEqual(result.indices, [1]);
  assert.equal(result.verification.status, 'flagged');
  assert.equal(result.verification.flagged_claims, 1);
});

test('does not treat snippets alone as scraped-page evidence', () => {
  const withoutPageText = [{ ...sources[0], raw_content: undefined }];
  const result = verifyCitedClaims('The Model Context Protocol is an open protocol [1]', withoutPageText);
  assert.equal(result.text, 'The Model Context Protocol is an open protocol [Unverified]');
  assert.deepEqual(result.indices, []);
  assert.equal(result.verification.status, 'flagged');
});

test('flags citation numbers that do not map to a supplied source', () => {
  const result = verifyCitedClaims('The Model Context Protocol is an open protocol [2]', sources);
  assert.equal(result.text, 'The Model Context Protocol is an open protocol [Unverified]');
  assert.deepEqual(result.indices, []);
});
