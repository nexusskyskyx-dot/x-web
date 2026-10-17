import type { APIContext } from 'astro';
import { json } from '../../lib/http.ts';
import { supabaseAnonKey, supabaseUrl } from '../../lib/account.ts';

export const prerender = false;

/** Public client configuration only. Never include the Supabase service-role key here. */
export function GET(_context: APIContext) {
  const url = supabaseUrl() ?? '';
  const anonKey = supabaseAnonKey() ?? '';
  return json({ supabaseUrl: url, supabaseAnonKey: anonKey, configured: Boolean(url && anonKey) });
}
