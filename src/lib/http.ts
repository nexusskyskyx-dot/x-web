/**
 * Shared HTTP plumbing for the v1 API: JSON responses, the error envelope,
 * request keying and a small in-memory rate limiter.
 */

import { env } from './env.ts';
import { isProvider, PROVIDER_META, type ProviderId } from './search.ts';

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export interface ApiError {
  type:
    | 'invalid_request_error'
    | 'authentication_error'
    | 'rate_limit_error'
    | 'upstream_error'
    | 'internal_error';
  code: string;
  message: string;
  param?: string;
  provider?: string;
}

export function errorResponse(
  error: ApiError,
  status: number,
): Response {
  return json({ error }, status);
}

export function invalidRequest(message: string, param?: string, code = 'invalid_request'): Response {
  return errorResponse({ type: 'invalid_request_error', code, message, param }, 400);
}

export function internalError(message: string, code = 'internal_error'): Response {
  return errorResponse({ type: 'internal_error', code, message }, 500);
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

interface Bucket {
  count: number;
  reset: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Per-instance limiter so a runaway loop cannot burn the site owner's
 * server-side key. On serverless this is per warm instance, which is the
 * right trade-off: it stops accidental floods without needing Redis.
 */
export function rateLimit(
  ip: string,
  opts: { windowMs?: number; max?: number } = {},
): { limited: boolean; remaining: number; reset: number } {
  const windowMs = opts.windowMs ?? Number(env('XWEB_RATE_WINDOW_MS') ?? 60_000);
  const max = opts.max ?? Number(env('XWEB_RATE_MAX') ?? 30);
  const now = Date.now();

  const bucket = buckets.get(ip);
  if (!bucket || bucket.reset < now) {
    buckets.set(ip, { count: 1, reset: now + windowMs });
    return { limited: false, remaining: max - 1, reset: now + windowMs };
  }

  bucket.count += 1;
  return {
    limited: bucket.count > max,
    remaining: Math.max(0, max - bucket.count),
    reset: bucket.reset,
  };
}

/** Opportunistic cleanup so long-lived dev servers don't grow without bound. */
export function pruneRateLimitBuckets(): void {
  if (buckets.size < 5000) return;
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (bucket.reset < now) buckets.delete(ip);
  }
}

/* ------------------------------------------------------------------ */
/* Request parsing                                                     */
/* ------------------------------------------------------------------ */

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 1_000_000) throw new BodyError('Request body must be 1 MB or smaller.');

  let text: string;
  try {
    // Read explicitly so chunked requests without Content-Length are also capped.
    text = await request.text();
  } catch {
    throw new BodyError();
  }
  if (new TextEncoder().encode(text).byteLength > 1_000_000) {
    throw new BodyError('Request body must be 1 MB or smaller.');
  }
  if (!text.trim()) return {};

  let parsed: unknown;
  try {
    // Be forgiving: some agents forget the content-type but still send JSON.
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError('Request body must be a JSON object.');
  }
  // A non-JSON content type is tolerated intentionally for simple clients.
  return parsed as Record<string, unknown>;
}

export class BodyError extends Error {
  constructor(message = 'Request body must be valid JSON.') {
    super(message);
    this.name = 'BodyError';
  }
}

/** Accept the same parameters on the query string as in the JSON body. */
export function searchParamsToBody(url: URL): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ['query', 'q', 'provider', 'topic', 'search_depth', 'language', 'country', 'time_range', 'query_rewrite']) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') body[key === 'q' ? 'query' : key] = value;
  }
  for (const key of ['max_results', 'extract_depth']) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') body[key] = Number(value);
  }
  for (const key of ['include_answer', 'include_raw_content', 'understand']) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') body[key] = value !== 'false' && value !== '0';
  }
  for (const key of ['include_domains', 'exclude_domains', 'urls']) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== '') {
      body[key] = value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Provider key resolution                                             */
/* ------------------------------------------------------------------ */

export interface KeyResolution {
  key: string;
  provider: ProviderId;
  /** Where the key came from — surfaced so callers can debug 401s. */
  source: 'header' | 'body' | 'server' | 'none';
}

/**
 * Keys are resolved in a fixed order: request header, request body, then the
 * server's own configured provider. A key supplied by the caller always wins,
 * which keeps the playground honest — it never silently spends the owner's
 * quota for a visitor.
 */
export function resolveKey(
  request: Request,
  body: Record<string, unknown>,
): KeyResolution {
  const headerKey =
    request.headers.get('x-xweb-key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const bodyKey = typeof body.api_key === 'string' ? body.api_key : undefined;

  const serverProvider = env('XWEB_SEARCH_PROVIDER');
  const serverKey =
    env('XWEB_SEARCH_API_KEY') ??
    (isProvider(serverProvider) ? env(PROVIDER_META[serverProvider].envVar) : undefined);

  const providerFromRequest = isProvider(body.provider) ? body.provider : undefined;

  if (headerKey?.trim()) {
    return {
      key: headerKey.trim(),
      provider: providerFromRequest ?? (isProvider(serverProvider) ? serverProvider : 'tavily'),
      source: 'header',
    };
  }
  if (bodyKey?.trim()) {
    return {
      key: bodyKey.trim(),
      provider: providerFromRequest ?? (isProvider(serverProvider) ? serverProvider : 'tavily'),
      source: 'body',
    };
  }
  if (serverKey?.trim()) {
    return {
      key: serverKey.trim(),
      provider: providerFromRequest ?? (isProvider(serverProvider) ? serverProvider : 'tavily'),
      source: 'server',
    };
  }
  return {
    key: '',
    provider: providerFromRequest ?? (isProvider(serverProvider) ? serverProvider : 'tavily'),
    source: 'none',
  };
}

export function missingKeyResponse(): Response {
  return errorResponse(
    {
      type: 'authentication_error',
      code: 'missing_api_key',
      message:
        'No search provider key available. Send `x-xweb-key` (or `Authorization: Bearer …`), pass `api_key` in the body, or set XWEB_SEARCH_API_KEY / a provider key on the server.',
    },
    401,
  );
}

export function clientIp(request: Request, fallback?: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? fallback ?? 'local';
}
