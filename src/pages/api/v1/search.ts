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
import { AccountAuthError, authenticateAccountApiKey, extractAccountApiKey, recordApiUsage, type AuthenticatedApiKey } from '../../../lib/account.ts';
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

  // An x-web account key identifies the caller. It is not a search-provider
  // credential; use the deployment's provider key to execute the query.
  const keyRequest = accountKey ? new Request(request.url) : request;
  const keyBody = accountKey ? { provider: body.provider } : body;
  const { key, provider, source } = resolveKey(keyRequest, keyBody);
  if (!key) {
    if (accountKey) {
      return errorResponse({ type: 'upstream_error', code: 'search_provider_not_configured', message: 'This x-web deployment has no search provider key configured yet.' }, 503);
    }
    return missingKeyResponse();
  }

  try {
    const result = await runPipeline({ ...body, provider: body.provider ?? provider }, { apiKey: key });
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
