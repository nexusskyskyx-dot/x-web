import type { APIContext } from 'astro';
import { AccountAuthError, authenticateAccountUser } from '../../../lib/account.ts';
import { decryptAiCredential, type AiCredential } from '../../../lib/ai-credentials.ts';
import { decryptProviderKeyMap, type StoredProviderCredential } from '../../../lib/provider-credentials.ts';
import { getAccountSearchPreference } from '../../../lib/account-search-preference.ts';
import { resolveResearchMode } from '../../../lib/research-mode.ts';
import { runPipeline, PipelineError } from '../../../lib/pipeline.ts';
import { SearchError } from '../../../lib/search.ts';
import {
  BodyError,
  clientIp,
  errorResponse,
  internalError,
  json,
  pruneRateLimitBuckets,
  rateLimit,
  readJsonBody,
} from '../../../lib/http.ts';

export const prerender = false;

export async function POST({ request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();
  const limit = rateLimit(clientIp(request, clientAddress));
  if (limit.limited) {
    return errorResponse({
      type: 'rate_limit_error',
      code: 'rate_limited',
      message: 'Too many requests. Slow down and retry shortly.',
    }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyError) {
      return errorResponse({ type: 'invalid_request_error', code: 'invalid_json', message: error.message }, 400);
    }
    return errorResponse({ type: 'invalid_request_error', code: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  try {
    const { user, admin } = await authenticateAccountUser(request);
    const [providerResult, aiResult] = await Promise.all([
      admin.from('provider_credentials').select('provider, encrypted_key, iv').eq('user_id', user.id),
      admin.from('ai_credentials').select('provider, model, encrypted_key, iv').eq('user_id', user.id).maybeSingle(),
    ]);
    if (providerResult.error) {
      return errorResponse({ type: 'internal_error', code: 'provider_credentials_unavailable', message: 'Could not load your saved search-provider credentials.' }, 503);
    }

    const providerKeys = await decryptProviderKeyMap((providerResult.data ?? []) as StoredProviderCredential[]);
    const aiConfig = !aiResult.error && aiResult.data
      ? await decryptAiCredential(aiResult.data as AiCredential)
      : undefined;
    if (Object.keys(providerKeys).length === 0) {
      return errorResponse({
        type: 'invalid_request_error',
        code: 'search_provider_not_configured',
        message: 'Save at least one search-provider API key in the dashboard before searching.',
      }, 400);
    }

    const storedMode = body.mode === undefined
      ? await getAccountSearchPreference(admin, user.id)
      : body.mode;
    let requestBody = body;
    if (storedMode === 'automatic') {
      requestBody = { ...body, mode: resolveResearchMode(typeof body.query === 'string' ? body.query : '', 'automatic') };
    } else if (body.mode === undefined && (storedMode === 'standard' || storedMode === 'deep')) {
      requestBody = { ...body, mode: storedMode };
    }
    const result = await runPipeline(requestBody, { providerKeys, aiConfig });
    await admin.from('usage_events').insert({
      user_id: user.id,
      endpoint: '/api/account/search',
      provider: result.provider,
      result_count: result.results.length,
      duration_ms: result.took_ms,
    });
    return json(result);
  } catch (error) {
    if (error instanceof AccountAuthError) {
      return errorResponse({
        type: error.status === 401 ? 'authentication_error' : 'internal_error',
        code: error.code,
        message: error.message,
      }, error.status);
    }
    if (error instanceof PipelineError) {
      return errorResponse({
        type: error.type as any,
        code: error.code,
        message: error.message,
        param: error.param,
      }, error.status);
    }
    if (error instanceof SearchError) {
      return errorResponse({
        type: 'upstream_error',
        code: `provider_${error.provider}_error`,
        message: error.message,
        provider: error.provider,
      }, error.status === 401 || error.status === 402 || error.status === 429 ? error.status : 502);
    }
    return internalError(error instanceof Error ? error.message : 'Search failed.');
  }
}
