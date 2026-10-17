/**
 * POST /api/v1/extract — fetch URLs and return clean, readable text.
 *
 * Search gives you a snippet; agents usually need the page. This is the
 * "snippets & extracted content" half of the Text & Search surface, usable on
 * its own for URLs you already have.
 */

import type { APIContext } from 'astro';
import { extractPages } from '../../../lib/extract.ts';
import {
  json,
  errorResponse,
  invalidRequest,
  internalError,
  rateLimit,
  pruneRateLimitBuckets,
  readJsonBody,
  searchParamsToBody,
  clientIp,
  BodyError,
} from '../../../lib/http.ts';

export const prerender = false;

const MAX_URLS = 10;

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
    if (error instanceof BodyError) return invalidRequest(error.message, undefined, 'invalid_json');
    return invalidRequest('Request body must be valid JSON.', undefined, 'invalid_json');
  }

  const raw = body.urls ?? (typeof body.url === 'string' ? [body.url] : undefined);
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalidRequest('`urls` must be a non-empty array of absolute URLs.', 'urls', 'missing_urls');
  }

  const urls = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return invalidRequest('`urls` must contain at least one URL string.', 'urls', 'missing_urls');
  }
  if (urls.length > MAX_URLS) {
    return invalidRequest(`\`urls\` accepts at most ${MAX_URLS} entries.`, 'urls', 'too_many_urls');
  }

  const started = Date.now();
  try {
    const results = await extractPages(urls, {
      maxChars: Math.min(Math.max(Number(body.max_chars) || 12_000, 500), 100_000),
      includeImages: body.include_images === true,
    });
    return json({
      id: `xweb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      object: 'extract',
      took_ms: Date.now() - started,
      count: results.length,
      succeeded: results.filter((page) => page.text).length,
      results,
    });
  } catch (error) {
    return internalError(error instanceof Error ? error.message : 'Extraction failed.');
  }
}

export async function GET({ url, request, clientAddress }: APIContext) {
  pruneRateLimitBuckets();
  const limit = rateLimit(clientIp(request, clientAddress), { max: 20 });
  if (limit.limited) {
    return errorResponse(
      { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests. Slow down and retry shortly.' },
      429,
    );
  }

  const params = searchParamsToBody(url);
  const urls = Array.isArray(params.urls) ? (params.urls as string[]) : [];
  if (urls.length === 0) return invalidRequest('`urls` is required.', 'urls', 'missing_urls');

  const started = Date.now();
  try {
    const results = await extractPages(urls.slice(0, MAX_URLS), { maxChars: 12_000 });
    return json({
      id: `xweb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      object: 'extract',
      took_ms: Date.now() - started,
      count: results.length,
      succeeded: results.filter((page) => page.text).length,
      results,
    });
  } catch (error) {
    return internalError(error instanceof Error ? error.message : 'Extraction failed.');
  }
}
