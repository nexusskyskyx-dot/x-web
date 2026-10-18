import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAccountSearchPreference } from './account-search-preference.ts';

function mockedAdmin(data: unknown, error: unknown = null, missingSemanticColumn = false) {
  let selected = '';
  const query = {
    select(columns: string) { selected = columns; return this; },
    eq() { return this; },
    async maybeSingle() {
      if (missingSemanticColumn && selected.includes('semantic_citation_check')) {
        return { data: null, error: { code: '42703', message: 'column semantic_citation_check does not exist' } };
      }
      return { data, error };
    },
  };
  return { from: () => query } as any;
}

test('account search preference defaults semantic citation review off', async () => {
  const preference = await getAccountSearchPreference(mockedAdmin({ default_search_mode: 'automatic' }), 'user-1');
  assert.deepEqual(preference, { mode: 'automatic', semanticCitationCheck: false });
});

test('loads the opted-in semantic citation setting and search mode together', async () => {
  const preference = await getAccountSearchPreference(mockedAdmin({
    default_search_mode: 'deep',
    semantic_citation_check: true,
  }), 'user-1');
  assert.deepEqual(preference, { mode: 'deep', semanticCitationCheck: true });
});

test('keeps account search working before the Preview semantic-review migration is applied', async () => {
  const preference = await getAccountSearchPreference(
    mockedAdmin({ default_search_mode: 'standard' }, null, true),
    'user-1',
  );
  assert.deepEqual(preference, { mode: 'standard', semanticCitationCheck: false });
});

test('fails clearly when the account search-mode migration is missing', async () => {
  await assert.rejects(
    () => getAccountSearchPreference(mockedAdmin(null, new Error('missing column')), 'user-1'),
    /account search preferences migration/,
  );
});
