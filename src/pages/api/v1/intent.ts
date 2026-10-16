/**
 * POST/GET /api/v1/intent — query understanding on its own.
 *
 * Turns "what's the latest on the MCP spec and how does it compare to function
 * calling?" into a structured intent: type, keywords, entities, recency window,
 * detected language and a query rewritten for a search index.
 *
 * Exposed separately because it is useful before you spend a search: route the
 * request, pick a provider, or show the user what you understood.
 */

import type { APIContext } from 'astro';
import { understandQuery, mergeIntentWithRequest, isTimeRange } from '../../../lib/intent.ts';
import {
  json,
  errorResponse,
  invalidRequest,
  rateLimit,
  pruneRateLimitBuckets,
  readJsonBody,
  searchParamsToBody,
  clientIp,
  BodyError,
} from '../../../lib/http.ts';

export const prerender = false;

function build(query: string, overrides: Record<string, unknown>) {
  const intent = understandQuery(query);

  const topic = overrides.topic;
  const timeRange = overrides.time_range;
  const country = overrides.country;

  const filters = mergeIntentWithRequest(intent, {
    topic: topic === 'general' || topic === 'news' ? topic : undefined,
    time_range: isTimeRange(timeRange) ? timeRange : undefined,
    country: typeof country === 'string' ? country : undefined,
  });

  return json({
    object: 'intent',
    query,
    intent: { ...intent, filters },
  });
}

export async function POST({ request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();
  const limit = rateLimit(clientIp(request, clientAddress), { max: 60 });
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

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return invalidRequest('`query` is required.', 'query', 'missing_query');

  return build(query, body);
}

export async function GET({ url, request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();
  const limit = rateLimit(clientIp(request, clientAddress), { max: 60 });
  if (limit.limited) {
    return errorResponse(
      { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests. Slow down and retry shortly.' },
      429,
    );
  }

  const params = searchParamsToBody(url);
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) return invalidRequest('`query` is required.', 'query', 'missing_query');

  return build(query, params);
}
