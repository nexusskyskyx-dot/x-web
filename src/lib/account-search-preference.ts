import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResearchModePreference } from './research-mode.ts';

export async function getAccountSearchPreference(
  admin: SupabaseClient,
  userId: string,
): Promise<ResearchModePreference> {
  const { data, error } = await admin
    .from('profiles')
    .select('default_search_mode')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error('Could not load the account search preference. Apply the search-mode migration first.');
  const value = data?.default_search_mode;
  return value === 'standard' || value === 'deep' || value === 'automatic' ? value : 'automatic';
}
