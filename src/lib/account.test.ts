import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual, generateApiKey, hashApiKey, supabaseAnonKey, supabaseUrl } from './account.ts';

describe('account API key primitives', () => {
  test('reads standard Supabase integration env vars at runtime', () => {
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'public-anon-key';
      assert.equal(supabaseUrl(), 'https://project.supabase.co');
      assert.equal(supabaseAnonKey(), 'public-anon-key');
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

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
