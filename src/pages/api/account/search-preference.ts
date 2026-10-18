import type { APIContext } from 'astro';
import { AccountAuthError, authenticateAccountUser } from '../../../lib/account.ts';
import { BodyError, errorResponse, internalError, invalidRequest, json, readJsonBody } from '../../../lib/http.ts';
import type { ResearchModePreference } from '../../../lib/research-mode.ts';
import { getAccountSearchPreference } from '../../../lib/account-search-preference.ts';

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
    const preference = await getAccountSearchPreference(admin, user.id);
    return json({ mode: preference.mode, semantic_citation_check: preference.semanticCitationCheck });
  } catch (error) { return authError(error) ?? internalError('Could not load search preferences.'); }
}

export async function PUT({ request }: APIContext) {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }
  if (body.mode !== undefined && !isMode(body.mode)) return invalidRequest('`mode` must be automatic, standard, or deep.', 'mode', 'invalid_search_mode');
  if (body.semantic_citation_check !== undefined && typeof body.semantic_citation_check !== 'boolean') {
    return invalidRequest('`semantic_citation_check` must be a boolean.', 'semantic_citation_check', 'invalid_semantic_citation_setting');
  }
  if (body.mode === undefined && body.semantic_citation_check === undefined) {
    return invalidRequest('Provide `mode` or `semantic_citation_check`.', undefined, 'missing_search_preference');
  }
  const updates: Record<string, unknown> = {};
  if (body.mode !== undefined) updates.default_search_mode = body.mode;
  if (body.semantic_citation_check !== undefined) updates.semantic_citation_check = body.semantic_citation_check;
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { error } = await admin.from('profiles').update(updates).eq('id', user.id);
    if (error) return internalError('Could not save search preferences. Apply the account search preferences migration first.', 'search_preferences_save_failed');
    return json({
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.semantic_citation_check !== undefined ? { semantic_citation_check: body.semantic_citation_check } : {}),
    });
  } catch (error) { return authError(error) ?? internalError('Could not save search preferences.'); }
}
