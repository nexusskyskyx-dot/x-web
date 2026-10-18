import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveResearchMode } from './research-mode.ts';

test('automatic mode keeps ordinary lookups standard', () => {
  assert.equal(resolveResearchMode('What time is it in Guatemala?', 'automatic'), 'standard');
  assert.equal(resolveResearchMode('Define photosynthesis', 'automatic'), 'standard');
});

test('automatic mode escalates research-heavy questions', () => {
  assert.equal(resolveResearchMode('Compare the latest AI model releases and their pros and cons', 'automatic'), 'deep');
  assert.equal(resolveResearchMode('Compara las tendencias recientes de energía solar en profundidad', 'automatic'), 'deep');
  assert.equal(resolveResearchMode('Current best app for making videos', 'automatic'), 'deep');
});

test('explicit standard and deep preferences are honored', () => {
  assert.equal(resolveResearchMode('Compare these options thoroughly', 'standard'), 'standard');
  assert.equal(resolveResearchMode('What is a web search?', 'deep'), 'deep');
});
