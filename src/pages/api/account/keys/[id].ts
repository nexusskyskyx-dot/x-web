import type { APIContext } from 'astro';
import { authenticateAccountUser, AccountAuthError } from '../../../../lib/account.ts';
import { errorResponse, internalError, json } from '../../../../lib/http.ts';

export const prerender = false;

export async function DELETE({ request, params }: APIContext) {
  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return errorResponse({ type: 'invalid_request_error', code: 'invalid_key_id', message: 'A valid API key id is required.' }, 400);
  }
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { data, error } = await admin.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('user_id', user.id).is('revoked_at', null).select('id').maybeSingle();
    if (error) return internalError('Could not revoke API key.', 'key_revocation_failed');
    if (!data) return errorResponse({ type: 'invalid_request_error', code: 'key_not_found', message: 'That active API key was not found.' }, 404);
    return json({ revoked: true, id: data.id });
  } catch (error) {
    if (error instanceof AccountAuthError) return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
    return internalError('Could not revoke API key.');
  }
}
