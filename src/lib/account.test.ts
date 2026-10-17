import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual, generateApiKey, hashApiKey, supabaseAnonKey, supabaseServerKey, supabaseUrl } from './account.ts';

describe('account API key primitives', () => {
  test('reads standard Supabase integration env vars at runtime', () => {
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'public-anon-key';
      process.env.SUPABASE_SECRET_KEY = 'server-secret-key';
      assert.equal(supabaseUrl(), 'https://project.supabase.co');
      assert.equal(supabaseAnonKey(), 'public-anon-key');
      assert.equal(supabaseServerKey(), 'server-secret-key');
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('tolerates mixed-case Supabase variable names from manual Vercel setup', () => {
    const names = ['SUPABASE_URL', 'PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'PUBLIC_SUPABASE_ANON_KEY', 'PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'supabase_URL', 'Supabase_anon_key', 'supabase_secret_key'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.supabase_URL = 'https://mixed-case.supabase.co';
      process.env.Supabase_anon_key = 'mixed-case-public-key';
      process.env.supabase_secret_key = 'mixed-case-server-secret';
      assert.equal(supabaseUrl(), 'https://mixed-case.supabase.co');
      assert.equal(supabaseAnonKey(), 'mixed-case-public-key');
      assert.equal(supabaseServerKey(), 'mixed-case-server-secret');
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
