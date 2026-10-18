import type { APIContext } from 'astro';
import { AccountAuthError, authenticateAccountUser } from '../../../lib/account.ts';
import { decryptScraperKey, type StoredScraperCredential } from '../../../lib/scraper-credentials.ts';
import { encryptProviderKey } from '../../../lib/provider-credentials.ts';
import { BodyError, errorResponse, internalError, invalidRequest, json, readJsonBody } from '../../../lib/http.ts';

export const prerender = false;

function authError(error: unknown): Response | undefined {
  if (error instanceof AccountAuthError) {
    return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
  }
  return undefined;
}

export async function GET({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { data, error } = await admin.from('scraper_credentials').select('encrypted_key, iv, updated_at').eq('user_id', user.id).maybeSingle();
    if (error) return internalError('Could not load the Firecrawl key. Apply the scraper-credentials Supabase migration first.', 'scraper_credentials_unavailable');
    if (!data) return json({ configured: false, updated_at: null });
    // Fail early if the encrypted credential cannot be decrypted.
    await decryptScraperKey(data as StoredScraperCredential);
    return json({ configured: true, updated_at: data.updated_at });
  } catch (error) { return authError(error) ?? internalError('Could not load the Firecrawl key.'); }
}

export async function PUT({ request }: APIContext) {
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
    const { error } = await admin.from('scraper_credentials').upsert({ user_id: user.id, ...encrypted, updated_at: updatedAt }, { onConflict: 'user_id' });
    if (error) return internalError('Could not save the Firecrawl key. Apply the scraper-credentials migration first.', 'scraper_key_save_failed');
    return json({ configured: true, updated_at: updatedAt });
  } catch (error) {
    const auth = authError(error);
    if (auth) return auth;
    if (error instanceof Error && error.message.includes('encryption is not configured')) {
      return errorResponse({ type: 'internal_error', code: 'provider_encryption_unavailable', message: 'Credential storage is not configured yet.' }, 503);
    }
    return internalError('Could not save the Firecrawl key.');
  }
}

export async function DELETE({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { error } = await admin.from('scraper_credentials').delete().eq('user_id', user.id);
    if (error) return internalError('Could not remove the Firecrawl key. Apply the scraper-credentials migration first.', 'scraper_key_remove_failed');
    return json({ configured: false });
  } catch (error) { return authError(error) ?? internalError('Could not remove the Firecrawl key.'); }
}
