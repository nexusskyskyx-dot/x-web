import type { APIContext } from 'astro';
import { authenticateAccountUser, AccountAuthError, generateApiKey, hashApiKey } from '../../../lib/account.ts';
import { BodyError, errorResponse, internalError, invalidRequest, json, readJsonBody } from '../../../lib/http.ts';

export const prerender = false;

export async function POST({ request }: APIContext) {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 48) return invalidRequest('API key name must be between 1 and 48 characters.', 'name', 'invalid_key_name');

  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { count, error: countError } = await admin.from('api_keys').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('revoked_at', null);
    if (countError) return internalError('Could not check API key limits.', 'account_data_unavailable');
    if ((count ?? 0) >= 10) return errorResponse({ type: 'invalid_request_error', code: 'key_limit_reached', message: 'You can have up to 10 active API keys. Revoke an unused key to create another.' }, 409);

    const key = generateApiKey();
    const { data, error } = await admin.from('api_keys').insert({
      user_id: user.id,
      name,
      prefix: key.slice(0, 16),
      key_hash: await hashApiKey(key),
    }).select('id, name, prefix, created_at').single();
    if (error || !data) return internalError('Could not create API key.', 'key_creation_failed');
    // This is the only response that contains the full secret. The database stores only its hash.
    return json({ key, api_key: data }, 201);
  } catch (error) {
    if (error instanceof AccountAuthError) return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
    return internalError('Could not create API key.');
  }
}
