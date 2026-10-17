/** POST /api/v1/images — provider-backed image search. */

import type { APIContext } from 'astro';
import { runImageSearch, ImageAuthError, ImageRequestError } from '../../../lib/images.ts';
import { SearchError } from '../../../lib/search.ts';
import {
  errorResponse,
  internalError,
  invalidRequest,
  pruneRateLimitBuckets,
  rateLimit,
  readJsonBody,
  clientIp,
  BodyError,
} from '../../../lib/http.ts';

export const prerender = false;

export async function POST({ request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();
  const limit = rateLimit(clientIp(request, clientAddress), { max: 20 });
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
    return invalidRequest(
      error instanceof BodyError ? error.message : 'Request body must be valid JSON.',
      undefined,
      'invalid_json',
    );
  }

  try {
    return new Response(JSON.stringify(await runImageSearch(request, body)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ImageRequestError) {
      return invalidRequest(error.message, error.param, error.code);
    }
    if (error instanceof ImageAuthError) {
      return errorResponse(
        { type: 'authentication_error', code: 'missing_api_key', message: error.message, provider: error.provider },
        401,
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
    return internalError(error instanceof Error ? error.message : 'Image search failed.');
  }
}
