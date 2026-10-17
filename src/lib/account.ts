import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { env } from './env.ts';

export interface AuthenticatedAccount {
  user: User;
  admin: SupabaseClient;
}

export interface AuthenticatedApiKey {
  userId: string;
  keyId: string;
  name: string;
}

export class AccountAuthError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 401, code = 'unauthorized') {
    super(message);
    this.name = 'AccountAuthError';
    this.status = status;
    this.code = code;
  }
}

export function supabaseUrl(): string | undefined {
  return env('SUPABASE_URL') ?? env('PUBLIC_SUPABASE_URL') ?? env('NEXT_PUBLIC_SUPABASE_URL');
}

export function supabaseAnonKey(): string | undefined {
  return env('SUPABASE_ANON_KEY') ?? env('SUPABASE_PUBLISHABLE_KEY') ?? env('PUBLIC_SUPABASE_ANON_KEY') ?? env('NEXT_PUBLIC_SUPABASE_ANON_KEY') ?? env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
}

export function isAccountConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey() && env('SUPABASE_SERVICE_ROLE_KEY'));
}

function createAdminClient(): SupabaseClient {
  const url = supabaseUrl();
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new AccountAuthError('Account services are not configured yet.', 503, 'account_service_unavailable');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function bearerToken(request: Request): string | undefined {
  const value = request.headers.get('authorization');
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export async function authenticateAccountUser(request: Request): Promise<AuthenticatedAccount> {
  const token = bearerToken(request);
  if (!token) throw new AccountAuthError('Sign in is required.', 401, 'missing_session');

  const url = supabaseUrl();
  const anonKey = supabaseAnonKey();
  if (!url || !anonKey || !env('SUPABASE_SERVICE_ROLE_KEY')) {
    throw new AccountAuthError('Account services are not configured yet.', 503, 'account_service_unavailable');
  }

  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new AccountAuthError('Your session is invalid or expired.', 401, 'invalid_session');
  return { user: data.user, admin: createAdminClient() };
}

export function extractAccountApiKey(request: Request): string | undefined {
  const header = request.headers.get('x-xweb-key') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const key = header?.trim();
  return key?.startsWith('xw_live_') ? key : undefined;
}

export async function authenticateAccountApiKey(key: string): Promise<AuthenticatedApiKey> {
  const admin = createAdminClient();
  const prefix = key.slice(0, 16);
  const { data, error } = await admin
    .from('api_keys')
    .select('id,user_id,name,key_hash')
    .eq('prefix', prefix)
    .is('revoked_at', null)
    .limit(10);

  if (error) throw new AccountAuthError('Could not validate API key.', 503, 'account_service_unavailable');
  const digest = await hashApiKey(key);
  const match = (data ?? []).find((row) => constantTimeEqual(row.key_hash, digest));
  if (!match) throw new AccountAuthError('The x-web API key is invalid or revoked.', 401, 'invalid_api_key');
  return { userId: match.user_id, keyId: match.id, name: match.name };
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `xw_live_${secret}`;
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison for equal-length digest strings. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function recordApiUsage(
  accountKey: AuthenticatedApiKey,
  details: { endpoint: string; provider: string; resultCount: number; durationMs: number },
): Promise<void> {
  const admin = createAdminClient();
  const [usage, keyUpdate] = await Promise.all([
    admin.from('usage_events').insert({
      user_id: accountKey.userId,
      api_key_id: accountKey.keyId,
      endpoint: details.endpoint,
      provider: details.provider,
      result_count: details.resultCount,
      duration_ms: details.durationMs,
    }),
    admin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', accountKey.keyId),
  ]);
  if (usage.error || keyUpdate.error) {
    // Never include request credentials or query contents in logs.
    console.warn('x-web account usage write failed', usage.error?.message ?? keyUpdate.error?.message);
  }
}
