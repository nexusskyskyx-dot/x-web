/**
 * Provider-backed image search plus normalized image metadata.
 *
 * Brave and Serper expose image-specific search APIs. Tavily and Exa do not
 * expose a dedicated image result endpoint through these adapters, so this
 * module never fakes image results from web search.
 */

import { env } from './env.ts';
import { SearchError } from './search.ts';

export const IMAGE_PROVIDERS = ['brave', 'serper'] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export interface ImageSearchRequest {
  query: string;
  provider?: ImageProvider;
  max_results?: number;
  country?: string;
  language?: string;
  safe_search?: 'strict' | 'off';
}

export interface ImageResult {
  /** Direct full-size image URL (when provided by the upstream provider). */
  image_url: string;
  /** Provider-hosted or upstream thumbnail URL; use this for previews. */
  thumbnail_url?: string;
  /** Source page containing the image. */
  page_url?: string;
  title: string;
  /** Search-result alt-text equivalent. Providers do not guarantee original HTML alt text. */
  alt_text?: string;
  source?: string;
  width?: number;
  height?: number;
  thumbnail_width?: number;
  thumbnail_height?: number;
  fetched_at?: string;
  position: number;
}

export interface ImageSearchResponse {
  id: string;
  object: 'image_search';
  query: string;
  provider: ImageProvider;
  took_ms: number;
  results: ImageResult[];
  unsupported_params?: string[];
}

const MAX_RESULTS = 50;
const TIMEOUT_MS = 20_000;

function cleanHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function providerError(provider: ImageProvider, status: number, payload: any): SearchError {
  const detail = payload?.error?.message ?? payload?.message ?? payload?.raw ?? `Upstream returned ${status}`;
  return new SearchError(String(detail), status, provider);
}

function normalizeBrave(payload: any): ImageResult[] {
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map((item: any, index: number): ImageResult | undefined => {
      const imageUrl = cleanHttpUrl(item?.properties?.url) ?? cleanHttpUrl(item?.thumbnail?.src);
      if (!imageUrl) return undefined;
      return {
        image_url: imageUrl,
        thumbnail_url: cleanHttpUrl(item?.thumbnail?.src) ?? imageUrl,
        page_url: cleanHttpUrl(item?.url),
        title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled image',
        alt_text: typeof item?.title === 'string' ? item.title.trim() || undefined : undefined,
        source: typeof item?.source === 'string' ? item.source : item?.meta_url?.hostname,
        width: positiveInt(item?.properties?.width),
        height: positiveInt(item?.properties?.height),
        thumbnail_width: positiveInt(item?.thumbnail?.width),
        thumbnail_height: positiveInt(item?.thumbnail?.height),
        fetched_at: normalizeDate(item?.page_fetched),
        position: index + 1,
      };
    })
    .filter((item: ImageResult | undefined): item is ImageResult => Boolean(item));
}

function normalizeSerper(payload: any): ImageResult[] {
  const rows = Array.isArray(payload?.images) ? payload.images : [];
  return rows
    .map((item: any, index: number): ImageResult | undefined => {
      const imageUrl = cleanHttpUrl(item?.imageUrl ?? item?.image_url);
      if (!imageUrl) return undefined;
      return {
        image_url: imageUrl,
        thumbnail_url: cleanHttpUrl(item?.thumbnailUrl ?? item?.thumbnail_url) ?? imageUrl,
        page_url: cleanHttpUrl(item?.link ?? item?.sourceUrl ?? item?.source_url),
        title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled image',
        alt_text: typeof item?.title === 'string' ? item.title.trim() || undefined : undefined,
        source: typeof item?.source === 'string' ? item.source : item?.domain,
        width: positiveInt(item?.imageWidth ?? item?.image_width),
        height: positiveInt(item?.imageHeight ?? item?.image_height),
        thumbnail_width: positiveInt(item?.thumbnailWidth ?? item?.thumbnail_width),
        thumbnail_height: positiveInt(item?.thumbnailHeight ?? item?.thumbnail_height),
        fetched_at: normalizeDate(item?.date),
        position: positiveInt(item?.position) ?? index + 1,
      };
    })
    .filter((item: ImageResult | undefined): item is ImageResult => Boolean(item));
}

export function isImageProvider(value: unknown): value is ImageProvider {
  return typeof value === 'string' && (IMAGE_PROVIDERS as readonly string[]).includes(value);
}

function getKey(provider: ImageProvider, request: Request, body: Record<string, unknown>): string {
  const header = request.headers.get('x-xweb-key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const bodyKey = typeof body.api_key === 'string' ? body.api_key : undefined;
  const defaultProvider = env('XWEB_SEARCH_PROVIDER');
  const genericSearchKey = defaultProvider === provider ? env('XWEB_SEARCH_API_KEY') : undefined;
  const serverKey = env('XWEB_IMAGE_SEARCH_API_KEY') ??
    genericSearchKey ??
    env(provider === 'brave' ? 'BRAVE_API_KEY' : 'SERPER_API_KEY');
  return (header || bodyKey || serverKey || '').trim();
}

export async function runImageSearch(
  request: Request,
  raw: Record<string, unknown>,
): Promise<ImageSearchResponse> {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) throw new ImageRequestError('`query` is required.', 'missing_query', 'query');
  if (query.length > 400) throw new ImageRequestError('`query` must be 400 characters or fewer.', 'query_too_long', 'query');

  const configuredImageProvider = env('XWEB_IMAGE_SEARCH_PROVIDER') ?? env('XWEB_SEARCH_PROVIDER');
  if (raw.provider !== undefined && !isImageProvider(raw.provider)) {
    throw new ImageRequestError('`provider` must be one of: brave, serper.', 'invalid_provider', 'provider');
  }
  const provider = isImageProvider(raw.provider)
    ? raw.provider
    : (isImageProvider(configuredImageProvider) ? configuredImageProvider : 'brave');
  if (raw.safe_search !== undefined && raw.safe_search !== 'strict' && raw.safe_search !== 'off') {
    throw new ImageRequestError('`safe_search` must be "strict" or "off".', 'invalid_safe_search', 'safe_search');
  }
  const maxResults = Math.min(Math.max(Math.trunc(Number(raw.max_results) || 20), 1), MAX_RESULTS);
  const safeSearch = raw.safe_search === 'off' ? raw.safe_search : 'strict';
  const key = getKey(provider, request, raw);
  if (!key) throw new ImageAuthError(provider);

  const started = Date.now();
  let response: Response;
  if (provider === 'brave') {
    const url = new URL('https://api.search.brave.com/res/v1/images/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    url.searchParams.set('safesearch', safeSearch);
    if (typeof raw.country === 'string' && raw.country.trim()) url.searchParams.set('country', raw.country.trim().toUpperCase());
    if (typeof raw.language === 'string' && raw.language.trim()) url.searchParams.set('search_lang', raw.language.trim().toLowerCase());
    response = await fetch(url, {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } else {
    const body: Record<string, unknown> = { q: query, num: Math.min(maxResults, 100) };
    if (typeof raw.country === 'string' && raw.country.trim()) body.gl = raw.country.trim().toLowerCase();
    if (typeof raw.language === 'string' && raw.language.trim()) body.hl = raw.language.trim().toLowerCase();
    response = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  const payload = await readJson(response);
  if (!response.ok) throw providerError(provider, response.status, payload);
  const results = (provider === 'brave' ? normalizeBrave(payload) : normalizeSerper(payload)).slice(0, maxResults);

  return {
    id: `xweb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    object: 'image_search',
    query,
    provider,
    took_ms: Date.now() - started,
    results,
    unsupported_params: provider === 'serper' && raw.safe_search !== undefined ? ['safe_search'] : undefined,
  };
}

export class ImageRequestError extends Error {
  code: string;
  param: string;
  constructor(message: string, code: string, param: string) {
    super(message);
    this.name = 'ImageRequestError';
    this.code = code;
    this.param = param;
  }
}

export class ImageAuthError extends Error {
  provider: ImageProvider;
  constructor(provider: ImageProvider) {
    super(`No ${provider} API key available. Send X-XWeb-Key, pass api_key in the body, or configure the server environment.`);
    this.name = 'ImageAuthError';
    this.provider = provider;
  }
}
