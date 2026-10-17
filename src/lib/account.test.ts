import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual, generateApiKey, hashApiKey } from './account.ts';

describe('account API key primitives', () => {
  test('generates a high-entropy, clearly prefixed key', () => {
    const first = generateApiKey();
    const second = generateApiKey();
    assert.match(first, /^xw_live_[a-f0-9]{64}$/);
    assert.notEqual(first, second);
  });

  test('stores a SHA-256 digest rather than the original key', async () => {
    const key = generateApiKey();
    const digest = await hashApiKey(key);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(digest, key);
    assert.equal(await hashApiKey(key), digest);
  });

  test('compares digest strings without early exit on equal-length values', () => {
    assert.equal(constantTimeEqual('a'.repeat(64), 'a'.repeat(64)), true);
    assert.equal(constantTimeEqual('a'.repeat(63) + 'b', 'a'.repeat(64)), false);
    assert.equal(constantTimeEqual('short', 'longer'), false);
  });
});
