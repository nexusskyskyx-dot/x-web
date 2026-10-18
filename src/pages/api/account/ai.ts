import type { APIContext } from 'astro';
import { authenticateAccountUser, AccountAuthError } from '../../../lib/account.ts';
import { AI_DEFAULT_MODELS, isAiProvider, type AiProvider } from '../../../lib/ai-credentials.ts';
import { encryptProviderKey } from '../../../lib/provider-credentials.ts';
import { BodyError, errorResponse, internalError, invalidRequest, json, readJsonBody } from '../../../lib/http.ts';

export const prerender = false;

function authError(error: unknown): Response | undefined {
  if (error instanceof AccountAuthError) return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
  return undefined;
}

export async function GET({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { data, error } = await admin.from('ai_credentials').select('provider, model, updated_at').eq('user_id', user.id).maybeSingle();
    if (error) return internalError('Could not load AI settings. Apply the AI-credentials migration first.', 'ai_settings_unavailable');
    return json({ configured: Boolean(data), provider: data?.provider ?? null, model: data?.model ?? null, updated_at: data?.updated_at ?? null });
  } catch (error) { return authError(error) ?? internalError('Could not load AI settings.'); }
}

export async function PUT({ request }: APIContext) {
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }
  if (!isAiProvider(body.provider)) return invalidRequest('`provider` must be openai, anthropic, groq, openrouter, or xkiro.', 'provider', 'invalid_ai_provider');
  const provider = body.provider as AiProvider;
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : AI_DEFAULT_MODELS[provider];
  if (!apiKey || apiKey.length > 2048) return invalidRequest('`api_key` is required and must be 2048 characters or fewer.', 'api_key', 'invalid_ai_key');
  if (model.length > 128 || !/^[\w./:-]+$/.test(model)) return invalidRequest('`model` must be a valid model identifier of 128 characters or fewer.', 'model', 'invalid_ai_model');

  try {
    const { user, admin } = await authenticateAccountUser(request);
    const encrypted = await encryptProviderKey(apiKey);
    const updatedAt = new Date().toISOString();
    const { error } = await admin.from('ai_credentials').upsert({ user_id: user.id, provider, model, ...encrypted, updated_at: updatedAt }, { onConflict: 'user_id' });
    if (error) return internalError('Could not save your AI settings. Ensure the AI-credentials migration is applied.', 'ai_settings_save_failed');
    return json({ configured: true, provider, model, updated_at: updatedAt });
  } catch (error) {
    if (error instanceof Error && error.message.includes('encryption is not configured')) return errorResponse({ type: 'internal_error', code: 'provider_encryption_unavailable', message: 'Secure AI key storage is not configured.' }, 503);
    return authError(error) ?? internalError('Could not save your AI settings.');
  }
}

export async function DELETE({ request }: APIContext) {
  try {
    const { user, admin } = await authenticateAccountUser(request);
    const { error } = await admin.from('ai_credentials').delete().eq('user_id', user.id);
    if (error) return internalError('Could not remove your saved AI key. Apply the AI-credentials migration first.', 'ai_settings_remove_failed');
    return json({ configured: false });
  } catch (error) { return authError(error) ?? internalError('Could not remove your AI settings.'); }
}
