/**
 * /api/search — the endpoint the on-site playground talks to.
 *
 * It is the same pipeline as /api/v1/search, kept as a separate path so the
 * playground's request shape stays stable while v1 evolves.
 */

import type { APIContext } from 'astro';
import { runPipeline, PipelineError } from '../../lib/pipeline.ts';
import { AccountAuthError, authenticateAccountApiKey, createAdminClient, extractAccountApiKey } from '../../lib/account.ts';
import { decryptProviderKeyMap, type StoredProviderCredential } from '../../lib/provider-credentials.ts';
import { decryptAiCredential, type AiCredential } from '../../lib/ai-credentials.ts';
import { getAccountSearchPreference } from '../../lib/account-search-preference.ts';
import { getAccountScraperKey } from '../../lib/scraper-credentials.ts';
import { resolveResearchMode } from '../../lib/research-mode.ts';
import { SearchError } from '../../lib/search.ts';
import {
  json,
  errorResponse,
  invalidRequest,
  internalError,
  rateLimit,
  pruneRateLimitBuckets,
  readJsonBody,
  resolveKey,
  missingKeyResponse,
  clientIp,
  BodyError,
} from '../../lib/http.ts';

export const prerender = false;

export async function POST({ request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();

  const limit = rateLimit(clientIp(request, clientAddress));
  if (limit.limited) {
    return errorResponse(
      { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests. Slow down and retry shortly.' },
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

  const accountToken = extractAccountApiKey(request);
  const { key, provider, source } = resolveKey(accountToken ? new Request(request.url) : request, body);
  let providerKeys: Partial<Record<'tavily' | 'brave' | 'serper' | 'exa', string>> = {};
  let aiConfig;
  let scraperApiKey: string | undefined = request.headers.get('X-Firecrawl-API-Key') ?? undefined;
  let account;
  if (accountToken) {
    try { account = await authenticateAccountApiKey(accountToken); }
    catch (error) {
      if (error instanceof AccountAuthError) return errorResponse({ type: 'authentication_error', code: error.code, message: error.message }, error.status);
      return internalError('Could not validate the x-web account key.');
    }
    const admin = createAdminClient();
    const [providerResult, aiResult] = await Promise.all([
      admin.from('provider_credentials').select('provider, encrypted_key, iv').eq('user_id', account.userId),
      admin.from('ai_credentials').select('provider, model, encrypted_key, iv').eq('user_id', account.userId).maybeSingle(),
    ]);
    try {
      if (!providerResult.error && providerResult.data?.length) providerKeys = await decryptProviderKeyMap(providerResult.data as StoredProviderCredential[]);
      if (!aiResult.error && aiResult.data) aiConfig = await decryptAiCredential(aiResult.data as AiCredential);
      if (body.deep_scrape === true) scraperApiKey = await getAccountScraperKey(admin, account.userId);
    } catch {
      return internalError('Could not unlock the credentials saved to your x-web account. Check the server encryption configuration.');
    }
  }
  if (!key && Object.keys(providerKeys).length === 0) return missingKeyResponse();

  try {
    let requestBody: Record<string, unknown> = { ...body, provider: body.provider ?? provider };
    let semanticCitationCheck = false;
    if (account) {
      const preference = await getAccountSearchPreference(createAdminClient(), account.userId);
      semanticCitationCheck = preference.semanticCitationCheck;
      if (body.mode === undefined || body.mode === 'automatic') {
        const preferredMode = body.mode === 'automatic' ? 'automatic' : preference.mode;
        requestBody = { ...requestBody, mode: resolveResearchMode(typeof body.query === 'string' ? body.query : '', preferredMode) };
      }
    }
    const result = await runPipeline(requestBody, { apiKey: account ? undefined : key, providerKeys, aiConfig, semanticCitationCheck, scraperApiKey });
    return json(result, 200, { 'X-XWEB-Key-Source': account ? 'account' : source });
  } catch (error) {
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
}
