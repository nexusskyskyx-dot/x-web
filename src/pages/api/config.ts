import type { APIContext } from 'astro';
import { json } from '../../lib/http.ts';
import { env } from '../../lib/env.ts';
import { supabaseAnonKey, supabaseUrl } from '../../lib/account.ts';

export const prerender = false;

/** Public client configuration only. Never include the Supabase service-role/secret key here. */
export function GET(_context: APIContext) {
  const url = supabaseUrl() ?? '';
  const anonKey = supabaseAnonKey() ?? '';
  const firstPresent = (names: string[]) => names.find((name) => Boolean(env(name))) ?? null;

  // Environment variable names only: useful for debugging Vercel scope/prefix issues without
  // disclosing values or any server credential.
  const detected = {
    url: firstPresent(['SUPABASE_URL', 'PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']),
    public_key: firstPresent([
      'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'PUBLIC_SUPABASE_ANON_KEY',
      'PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ]),
    server_key: firstPresent(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']),
  };

  return json({ supabaseUrl: url, supabaseAnonKey: anonKey, configured: Boolean(url && anonKey), detected });
}
