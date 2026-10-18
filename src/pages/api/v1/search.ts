/**
 * POST/GET /api/v1/search — the x-web search endpoint.
 *
 * One endpoint for web search: live results, an AI-synthesised answer with
 * citations, extracted page content, multi-language support and query
 * understanding. See /docs/api for the full contract.
 */

import type { APIContext } from 'astro';
import { runPipeline, PipelineError } from '../../../lib/pipeline.ts';
import { SearchError } from '../../../lib/search.ts';
import { AccountAuthError, authenticateAccountApiKey, createAdminClient, extractAccountApiKey, recordApiUsage, type AuthenticatedApiKey } from '../../../lib/account.ts';
import { decryptProviderKeyMap, type StoredProviderCredential } from '../../../lib/provider-credentials.ts';
import { decryptAiCredential, type AiCredential, type AiRuntimeConfig } from '../../../lib/ai-credentials.ts';
import { getAccountSearchPreference } from '../../../lib/account-search-preference.ts';
import { getAccountScraperKey } from '../../../lib/scraper-credentials.ts';
import { resolveResearchMode } from '../../../lib/research-mode.ts';
import {
  json,
  errorResponse,
  invalidRequest,
  internalError,
  rateLimit,
  pruneRateLimitBuckets,
  readJsonBody,
  searchParamsToBody,
  resolveKey,
  missingKeyResponse,
  clientIp,
  BodyError,
} from '../../../lib/http.ts';

export const prerender = false;

export async function POST({ request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();

  const limit = rateLimit(clientIp(request, clientAddress));
  if (limit.limited) {
    return errorResponse(
      {
        type: 'rate_limit_error',
        code: 'rate_limited',
        message: 'Too many requests. Slow down and retry shortly.',
      },
      429,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }

  return runSearchRequest(request, body);
}

/** Read-only searches via query string — handy for curl and for agents that GET. */
export async function GET({ url, request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();

  const limit = rateLimit(clientIp(request, clientAddress));
  if (limit.limited) {
    return errorResponse(
      { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests. Slow down and retry shortly.' },
      429,
    );
  }

  const body = searchParamsToBody(url);
  if (!body.query) return invalidRequest('`query` is required.', 'query', 'missing_query');

  return runSearchRequest(request, body);
}

async function runSearchRequest(request: Request, body: Record<string, unknown>): Promise<Response> {
  let accountKey: AuthenticatedApiKey | undefined;
  const presentedAccountKey = extractAccountApiKey(request);
  if (presentedAccountKey) {
    try { accountKey = await authenticateAccountApiKey(presentedAccountKey); }
    catch (error) {
      if (error instanceof AccountAuthError) {
        return errorResponse({ type: error.status === 401 ? 'authentication_error' : 'internal_error', code: error.code, message: error.message }, error.status);
      }
      return internalError('Could not validate API key.');
    }
  }

  // x-web account keys identify the caller; saved provider credentials are
  // separately encrypted at rest and loaded only for that account.
  const keyRequest = accountKey ? new Request(request.url) : request;
  const keyBody = accountKey ? { provider: body.provider } : body;
  const { key, provider, source } = resolveKey(keyRequest, keyBody);
  let providerKeys: Partial<Record<'tavily' | 'brave' | 'serper' | 'exa', string>> = {};
  let aiConfig: AiRuntimeConfig | undefined;
  let scraperApiKey: string | undefined = request.headers.get('X-Firecrawl-API-Key') ?? undefined;
  if (accountKey) {
    const { data, error } = await createAdminClient()
      .from('provider_credentials')
      .select('provider, encrypted_key, iv')
      .eq('user_id', accountKey.userId);
    // Keep existing account-key search working with deployment credentials if
    // the optional provider-key migration has not yet been applied.
    if (!error && data?.length) {
      try {
        providerKeys = await decryptProviderKeyMap(data as StoredProviderCredential[]);
      } catch {
        return errorResponse({ type: 'internal_error', code: 'provider_key_decryption_failed', message: 'Could not unlock your saved provider keys. Check the server encryption configuration.' }, 503);
      }
    }
    const aiResult = await createAdminClient().from('ai_credentials').select('provider, model, encrypted_key, iv').eq('user_id', accountKey.userId).maybeSingle();
    if (!aiResult.error && aiResult.data) {
      try { aiConfig = await decryptAiCredential(aiResult.data as AiCredential); }
      catch { return errorResponse({ type: 'internal_error', code: 'ai_key_decryption_failed', message: 'Could not unlock your saved AI key. Check the server encryption configuration.' }, 503); }
    }
    if (body.deep_scrape === true) {
      try { scraperApiKey = await getAccountScraperKey(createAdminClient(), accountKey.userId); }
      catch { return errorResponse({ type: 'internal_error', code: 'scraper_credentials_unavailable', message: 'Could not load the Firecrawl key saved in your Dashboard.' }, 503); }
    }
  }
  if (!key && Object.keys(providerKeys).length === 0) {
    if (accountKey) {
      return errorResponse({ type: 'upstream_error', code: 'search_provider_not_configured', message: 'Add a search provider key in your dashboard or configure one on the x-web server.' }, 503);
    }
    return missingKeyResponse();
  }

  try {
    const pipelineBody: Record<string, unknown> = accountKey && body.provider === undefined
      ? { ...body }
      : { ...body, provider: body.provider ?? provider };
    let semanticCitationCheck = false;
    if (accountKey) {
      const preference = await getAccountSearchPreference(createAdminClient(), accountKey.userId);
      semanticCitationCheck = preference.semanticCitationCheck;
      if (body.mode === undefined || body.mode === 'automatic') {
        const preferredMode = body.mode === 'automatic' ? 'automatic' : preference.mode;
        pipelineBody.mode = resolveResearchMode(typeof body.query === 'string' ? body.query : '', preferredMode);
      }
    }
    const result = await runPipeline(pipelineBody, { apiKey: accountKey ? undefined : key, providerKeys, aiConfig, semanticCitationCheck, scraperApiKey });
    if (accountKey) {
      await recordApiUsage(accountKey, { endpoint: '/api/v1/search', provider: result.provider, resultCount: result.results.length, durationMs: result.took_ms });
    }
    return json(result, 200, { 'X-XWEB-Key-Source': accountKey ? 'account' : source });
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown): Response {
  if (error instanceof PipelineError) {
    return errorResponse(
      { type: error.type as any, code: error.code, message: error.message, param: error.param },
      error.status,
    );
  }
  if (error instanceof SearchError) {
    if (error.provider === 'multi' && error.status === 400) {
      return errorResponse({ type: 'invalid_request_error', code: 'no_available_provider_keys', message: error.message }, 400);
    }
    const status = error.status === 401 || error.status === 402 || error.status === 429 ? error.status : 502;
    return errorResponse(
      {
        type: error.status === 429 ? 'rate_limit_error' : 'upstream_error',
        code: `provider_${error.provider}_error`,
        message: error.message,
        provider: error.provider,
      },
      status,
    );
  }
  return internalError(error instanceof Error ? error.message : 'Search failed.');
}
