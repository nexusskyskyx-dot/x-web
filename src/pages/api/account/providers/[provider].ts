import type { APIContext } from 'astro';
import { authenticateAccountUser, AccountAuthError } from '../../../../lib/account.ts';
import { encryptProviderKey } from '../../../../lib/provider-credentials.ts';
import { BodyError, errorResponse, internalError, invalidRequest, json, readJsonBody } from '../../../../lib/http.ts';
import { isProvider } from '../../../../lib/search.ts';

export const prerender = false;

function authError(error: unknown): Response | undefined {
  if (error instanceof AccountAuthError) {
    return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
  }
  return undefined;
}

export async function PUT({ request, params }: APIContext) {
  const provider = params.provider;
  if (!isProvider(provider)) return invalidRequest('`provider` must be one of: tavily, brave, serper, exa.', 'provider', 'invalid_provider');

  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (!apiKey || apiKey.length > 1024) return invalidRequest('`api_key` is required and must be 1024 characters or fewer.', 'api_key', 'invalid_api_key');

  try {
    const { user, admin } = await authenticateAccountUser(request);
    const encrypted = await encryptProviderKey(apiKey);
    const updatedAt = new Date().toISOString();
    const { error } = await admin.from('provider_credentials').upsert({
      user_id: user.id,
      provider,
      ...encrypted,
      updated_at: updatedAt,
    }, { onConflict: 'user_id,provider' });
    if (error) return internalError('Could not save this provider key. Ensure the provider-credentials migration is applied and the encryption secret is configured.', 'provider_key_save_failed');
    return json({ provider, configured: true, updated_at: updatedAt });
  } catch (error) {
    const auth = authError(error);
    if (auth) return auth;
    if (error instanceof Error && error.message.includes('encryption is not configured')) {
      return errorResponse({ type: 'internal_error', code: 'provider_encryption_unavailable', message: 'Provider key storage is not configured yet.' }, 503);
    }
    return internalError('Could not save this provider key.');
  }
}

export async function DELETE({ request, params }: APIContext) {
  const provider = params.provider;
  if (!isProvider(provider)) return invalidRequest('`provider` must be one of: tavily, brave, serper, exa.', 'provider', 'invalid_provider');

  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { error } = await admin.from('provider_credentials').delete().eq('user_id', user.id).eq('provider', provider);
    if (error) return internalError('Could not remove this provider key. Apply the provider-credentials Supabase migration first.', 'provider_key_remove_failed');
    return json({ provider, configured: false });
  } catch (error) {
    return authError(error) ?? internalError('Could not remove this provider key.');
  }
}
