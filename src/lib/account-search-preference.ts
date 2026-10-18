import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResearchModePreference } from './research-mode.ts';

export interface AccountSearchPreference {
  mode: ResearchModePreference;
  semanticCitationCheck: boolean;
}

function isMissingSemanticColumn(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === '42703' || error.message?.includes('semantic_citation_check')));
}

function preferenceFrom(data: any, semanticAvailable: boolean): AccountSearchPreference {
  const value = data?.default_search_mode;
  return {
    mode: value === 'standard' || value === 'deep' || value === 'automatic' ? value : 'automatic',
    semanticCitationCheck: semanticAvailable && data?.semantic_citation_check === true,
  };
}

export async function getAccountSearchPreference(
  admin: SupabaseClient,
  userId: string,
): Promise<AccountSearchPreference> {
  const { data, error } = await admin
    .from('profiles')
    .select('default_search_mode, semantic_citation_check')
    .eq('id', userId)
    .maybeSingle();
  if (!error) return preferenceFrom(data, true);

  // Keep the existing mode preference and account search usable while a Preview
  // database is waiting for the opt-in semantic-review migration to be applied.
  if (isMissingSemanticColumn(error)) {
    const fallback = await admin.from('profiles').select('default_search_mode').eq('id', userId).maybeSingle();
    if (!fallback.error) return preferenceFrom(fallback.data, false);
  }
  throw new Error('Could not load account search preferences. Apply the account search preferences migration first.');
}
