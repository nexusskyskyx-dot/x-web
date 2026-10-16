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

  const { key, provider, source } = resolveKey(request, body);
  if (!key) return missingKeyResponse();

  try {
    const result = await runPipeline({ ...body, provider: body.provider ?? provider }, { apiKey: key });
    return json(result, 200, { 'X-XWEB-Key-Source': source });
  } catch (error) {
    return handleError(error);
  }
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

  const { key, provider, source } = resolveKey(request, body);
  if (!key) return missingKeyResponse();

  try {
    const result = await runPipeline({ ...body, provider: body.provider ?? provider }, { apiKey: key });
    return json(result, 200, { 'X-XWEB-Key-Source': source });
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
