import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyCitedClaims, verifyCitedClaimsWithSemantic } from './citation-verification.ts';
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

test('batches flagged claim citations into one semantic review and only accepts supported candidate IDs', async () => {
  const text = 'A claim with a paraphrase [1]. Another claim without matching evidence [1]';
  let calls = 0;
  const result = await verifyCitedClaimsWithSemantic(text, sources, async (candidates) => {
    calls += 1;
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((candidate) => candidate.citation_index), [1, 1]);
    return { checked_ids: candidates.map((candidate) => candidate.id), supported_ids: [candidates[0].id] };
  });
  assert.equal(calls, 1);
  assert.equal(result.text, 'A claim with a paraphrase [1]. Another claim without matching evidence [Unverified]');
  assert.deepEqual(result.indices, [1]);
  assert.deepEqual(result.verification, {
    status: 'flagged',
    supported_claims: 1,
    flagged_claims: 1,
    method: 'lexical_plus_semantic',
    semantic_checked_claims: 2,
    semantic_supported_claims: 1,
  });
});

test('keeps claims unverified when semantic review errors or does not check them', async () => {
  const text = 'An unsupported paraphrase claim [1]';
  const failed = await verifyCitedClaimsWithSemantic(text, sources, async () => { throw new Error('provider unavailable'); });
  assert.equal(failed.text, 'An unsupported paraphrase claim [Unverified]');
  assert.deepEqual(failed.indices, []);
  const incomplete = await verifyCitedClaimsWithSemantic(text, sources, async () => ({ checked_ids: [], supported_ids: [] }));
  assert.equal(incomplete.text, 'An unsupported paraphrase claim [Unverified]');
  assert.deepEqual(incomplete.verification, {
    status: 'flagged', supported_claims: 0, flagged_claims: 1, method: 'source_text_overlap',
  });
});
