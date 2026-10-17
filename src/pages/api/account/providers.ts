import type { APIContext } from 'astro';
import { authenticateAccountUser, AccountAuthError } from '../../../lib/account.ts';
import { errorResponse, internalError, json } from '../../../lib/http.ts';
import { PROVIDERS } from '../../../lib/search.ts';

export const prerender = false;

export async function GET({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { data, error } = await admin
      .from('provider_credentials')
      .select('provider, updated_at')
      .eq('user_id', user.id);
    if (error) return internalError('Could not load search provider settings. Apply the provider-credentials Supabase migration first.', 'provider_settings_unavailable');

    const configured = new Map((data ?? []).map((item) => [item.provider, item.updated_at]));
    return json({
      providers: PROVIDERS.map((provider) => ({
        provider,
        configured: configured.has(provider),
        updated_at: configured.get(provider) ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof AccountAuthError) {
      return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
    }
    return internalError('Could not load search provider settings.');
  }
}
