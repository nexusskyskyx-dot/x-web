import type { APIContext } from 'astro';
import {
  isProvider,
  runSearch,
  SearchError,
  PROVIDER_META,
  type ProviderId,
  type SearchRequest,
} from '../../lib/search';

export const prerender = false;

function env(name: string): string | undefined {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProcess ?? (import.meta.env as Record<string, string | undefined>)[name];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/* Very small per-instance limiter so a runaway loop cannot burn the
   site owner's server-side key. On serverless this is per warm instance. */
const hits = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 60_000;
const MAX_HITS = 30;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.reset < now) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_HITS;
}

export async function POST({ request, clientAddress }: APIContext) {
  if (rateLimited(clientAddress ?? 'local')) {
    return json(
      { error: { type: 'rate_limit_error', code: 'rate_limited', message: 'Too many requests. Slow down.' } },
      429,
    );
  }

  let body: Partial<SearchRequest> & { api_key?: string };
  try {
    body = await request.json();
  } catch {
    return json(
      { error: { type: 'invalid_request_error', code: 'invalid_json', message: 'Request body must be valid JSON.' } },
      400,
    );
  }

  const query = (body.query ?? '').toString().trim();
  if (!query) {
    return json(
      { error: { type: 'invalid_request_error', code: 'missing_query', message: '`query` is required.' } },
      400,
    );
  }

  const headerKey = request.headers.get('x-xweb-key') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const serverProvider = env('XWEB_SEARCH_PROVIDER');
  const serverKey =
    env('XWEB_SEARCH_API_KEY') ??
    (serverProvider ? env(PROVIDER_META[serverProvider as ProviderId]?.envVar ?? '') : undefined);

  const key = (headerKey || body.api_key || serverKey || '').trim();
  const provider = isProvider(body.provider)
    ? body.provider
    : isProvider(serverProvider)
      ? serverProvider
      : ('tavily' as ProviderId);

  if (!key) {
    return json(
      {
        error: {
          type: 'authentication_error',
          code: 'missing_api_key',
          message:
            'Add a provider API key. Paste one in the playground, send it as `x-xweb-key`, or set XWEB_SEARCH_API_KEY on the server.',
        },
      },
      401,
    );
  }

  const request_: SearchRequest = {
    query,
    provider,
    max_results: Math.min(Math.max(Number(body.max_results ?? 5) || 5, 1), 20),
    include_domains: body.include_domains,
    exclude_domains: body.exclude_domains,
    include_answer: body.include_answer ?? true,
    include_raw_content: body.include_raw_content ?? false,
    search_depth: body.search_depth,
    topic: body.topic,
    language: body.language,
    country: body.country,
  };

  const started = Date.now();
  try {
    const result = await runSearch(key, request_, { apiBase: env('XWEB_API_BASE') });
    result.took_ms = result.took_ms || Date.now() - started;
    return json(result);
  } catch (error) {
    if (error instanceof SearchError) {
      const status = error.status === 401 || error.status === 402 || error.status === 429 ? error.status : 502;
      return json(
        {
          error: {
            type: error.status === 429 ? 'rate_limit_error' : 'upstream_error',
            code: `provider_${error.provider}_error`,
            message: error.message,
            provider: error.provider,
          },
        },
        status,
      );
    }
    return json(
      {
        error: {
          type: 'internal_error',
          code: 'search_failed',
          message: error instanceof Error ? error.message : 'Search failed.',
        },
      },
      500,
    );
  }
}
