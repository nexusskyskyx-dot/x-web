import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptProviderKey } from './provider-credentials.ts';

export interface StoredScraperCredential {
  encrypted_key: string;
  iv: string;
}

export async function decryptScraperKey(credential: StoredScraperCredential): Promise<string> {
  return decryptProviderKey(credential);
}

export async function getAccountScraperKey(admin: SupabaseClient, userId: string): Promise<string | undefined> {
  const { data, error } = await admin.from('scraper_credentials')
    .select('encrypted_key, iv').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('Could not load your saved Firecrawl credential. Apply the scraper-credentials migration first.');
  return data ? decryptScraperKey(data as StoredScraperCredential) : undefined;
}
