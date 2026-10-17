import type { APIContext } from 'astro';
import { json } from '../../lib/http.ts';
import { supabaseAnonKey, supabaseUrl, supabaseDetectedEnvNames } from '../../lib/account.ts';

export const prerender = false;

/** Public client configuration only. Never include the Supabase service-role/secret key here. */
export function GET(_context: APIContext) {
  const url = supabaseUrl() ?? '';
  const anonKey = supabaseAnonKey() ?? '';
  // Names only; no values or server credentials are exposed in diagnostics.
  const detected = supabaseDetectedEnvNames();
  return json({ supabaseUrl: url, supabaseAnonKey: anonKey, configured: Boolean(url && anonKey), detected });
}
