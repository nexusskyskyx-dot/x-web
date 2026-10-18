import type { APIContext } from 'astro';
import { AccountAuthError, authenticateAccountUser } from '../../../lib/account.ts';
import { BodyError, errorResponse, internalError, invalidRequest, json, readJsonBody } from '../../../lib/http.ts';
import type { ResearchModePreference } from '../../../lib/research-mode.ts';

const isMode = (value: unknown): value is ResearchModePreference =>
  value === 'automatic' || value === 'standard' || value === 'deep';

function authError(error: unknown): Response | undefined {
  if (error instanceof AccountAuthError) {
    return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
  }
  return undefined;
}

export const prerender = false;

export async function GET({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { data, error } = await admin.from('profiles').select('default_search_mode').eq('id', user.id).maybeSingle();
    if (error) return internalError('Could not load search preferences. Apply the search-mode migration first.', 'search_preferences_unavailable');
    return json({ mode: isMode(data?.default_search_mode) ? data.default_search_mode : 'automatic' });
  } catch (error) { return authError(error) ?? internalError('Could not load search preferences.'); }
}

export async function PUT({ request }: APIContext) {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }
  if (!isMode(body.mode)) return invalidRequest('`mode` must be automatic, standard, or deep.', 'mode', 'invalid_search_mode');
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { error } = await admin.from('profiles').update({ default_search_mode: body.mode }).eq('id', user.id);
    if (error) return internalError('Could not save search preferences. Apply the search-mode migration first.', 'search_preferences_save_failed');
    return json({ mode: body.mode });
  } catch (error) { return authError(error) ?? internalError('Could not save search preferences.'); }
}
