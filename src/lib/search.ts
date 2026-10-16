/**
 * x-web — provider-agnostic web search.
 *
 * Every upstream provider is normalised into the same x-web response shape so
 * that an agent never has to care which index answered the question:
 *
 *   { id, query, provider, answer?, results: [{ title, url, snippet, score? }], took_ms }
 *
 * Set XWEB_API_BASE to point the playground at a real x-web deployment
 * (e.g. https://api.x-web.dev/v1) instead of talking to a provider directly.
 */

export const PROVIDERS = ['tavily', 'brave', 'serper', 'exa'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_META: Record<
  ProviderId,
  { label: string; envVar: string; keyPrefix: string; blurb: string; docs: string }
> = {
  tavily: {
    label: 'Tavily',
    envVar: 'TAVILY_API_KEY',
    keyPrefix: 'tvly-',
    blurb: 'Built for agents — returns an optional synthesised answer with every search.',
    docs: 'https://docs.tavily.com',
  },
  brave: {
    label: 'Brave Search',
    envVar: 'BRAVE_API_KEY',
    keyPrefix: 'BSA',
    blurb: 'Independent web index with strong freshness filtering and country targeting.',
    docs: 'https://api-dashboard.search.brave.com',
  },
  serper: {
    label: 'Serper',
    envVar: 'SERPER_API_KEY',
    keyPrefix: '',
    blurb: 'Google results with knowledge panels, answer boxes and top stories.',
    docs: 'https://serper.dev',
  },
  exa: {
    label: 'Exa',
    envVar: 'EXA_API_KEY',
    keyPrefix: 'exa_',
    blurb: 'Neural search tuned for semantic similarity — great for research.',
    docs: 'https://docs.exa.ai',
  },
};

export interface SearchRequest {
  query: string;
  provider?: ProviderId;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  include_answer?: boolean;
  include_raw_content?: boolean;
  search_depth?: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  language?: string;
  country?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  published_date?: string;
  raw_content?: string;
}

export interface SearchResponse {
  id: string;
  query: string;
  provider: string;
  answer?: string;
  results: SearchHit[];
  took_ms: number;
}

export class SearchError extends Error {
  status: number;
  provider: string;
  constructor(message: string, status: number, provider: string) {
    super(message);
    this.name = 'SearchError';
    this.status = status;
    this.provider = provider;
  }
}

const TIMEOUT_MS = 25_000;

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Brave and Serper have no domain parameters — both honour `site:` query operators. */
function applySiteOperators(query: string, include: string[], exclude: string[]): string {
  let out = query;
  if (include.length > 0) {
    out += ` (${include.map((d) => `site:${d}`).join(' OR ')})`;
  }
  for (const domain of exclude) {
    out += ` -site:${domain}`;
  }
  return out;
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function upstreamError(provider: ProviderId, status: number, payload: any): SearchError {
  const detail =
    payload?.error?.message ||
    payload?.message ||
    payload?.detail ||
    payload?.raw ||
    `Upstream provider returned ${status}`;
  const friendly: Record<number, string> = {
    401: 'The API key was rejected by the provider.',
    402: 'The provider account is out of credit.',
    403: 'The provider denied access to this key.',
    429: 'The provider is rate limiting this key.',
  };
  return new SearchError(friendly[status] ? `${friendly[status]} ${detail}` : String(detail), status, provider);
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

async function searchTavily(key: string, req: SearchRequest): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    query: req.query,
    max_results: req.max_results ?? 5,
    search_depth: req.search_depth ?? 'basic',
    include_answer: req.include_answer ?? true,
    include_raw_content: req.include_raw_content ?? false,
    include_domains: cleanList(req.include_domains),
    exclude_domains: cleanList(req.exclude_domains),
    topic: req.topic ?? 'general',
  };
  if (req.country) body.country = req.country;
  if (req.language) body.language = req.language;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('tavily', response.status, payload);

  return {
    id: `xweb_${crypto.randomUUID().slice(0, 8)}`,
    query: payload.query ?? req.query,
    provider: 'tavily',
    answer: payload.answer || undefined,
    results: (payload.results ?? []).map((item: any) => ({
      title: item.title ?? 'Untitled',
      url: item.url ?? '',
      snippet: item.content ?? '',
      score: typeof item.score === 'number' ? item.score : undefined,
      published_date: item.published_date,
      raw_content: item.raw_content,
    })),
    took_ms: 0,
  };
}

async function searchBrave(key: string, req: SearchRequest): Promise<SearchResponse> {
  const include = cleanList(req.include_domains);
  const exclude = cleanList(req.exclude_domains);
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', applySiteOperators(req.query, include, exclude));
  url.searchParams.set('count', String(Math.min(req.max_results ?? 5, 20)));
  if (req.country) url.searchParams.set('country', req.country);
  if (req.language) url.searchParams.set('search_lang', req.language);
  url.searchParams.set('extra_snippets', 'true');

  const response = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('brave', response.status, payload);

  return {
    id: `xweb_${crypto.randomUUID().slice(0, 8)}`,
    query: req.query,
    provider: 'brave',
    results: (payload?.web?.results ?? []).map((item: any) => ({
      title: item.title ?? 'Untitled',
      url: item.url ?? '',
      snippet: item.description ?? '',
      score: undefined,
      published_date: item.page_age ? item.page_age : undefined,
    })),
    took_ms: 0,
  };
}

async function searchSerper(key: string, req: SearchRequest): Promise<SearchResponse> {
  const include = cleanList(req.include_domains);
  const exclude = cleanList(req.exclude_domains);
  const body: Record<string, unknown> = {
    q: applySiteOperators(req.query, include, exclude),
    num: Math.min(req.max_results ?? 5, 20),
  };
  if (req.country) body.gl = req.country;
  if (req.language) body.hl = req.language;

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('serper', response.status, payload);

  const answerBox = payload?.answerBox;
  const knowledge = payload?.knowledgeGraph;
  const answer =
    answerBox?.answer ??
    answerBox?.snippet ??
    (knowledge?.description ? `${knowledge.title}: ${knowledge.description}` : undefined);

  const results: SearchHit[] = (payload?.organic ?? []).map((item: any) => ({
    title: item.title ?? 'Untitled',
    url: item.link ?? '',
    snippet: item.snippet ?? '',
    score: undefined,
    published_date: item.date,
  }));

  if (answerBox?.link && !results.some((r) => r.url === answerBox.link)) {
    results.unshift({
      title: answerBox.title ?? 'Answer',
      url: answerBox.link ?? '',
      snippet: answerBox.snippet ?? answerBox.answer ?? '',
    });
  }

  return {
    id: `xweb_${crypto.randomUUID().slice(0, 8)}`,
    query: req.query,
    provider: 'serper',
    answer,
    results,
    took_ms: 0,
  };
}

async function searchExa(key: string, req: SearchRequest): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    query: req.query,
    numResults: Math.min(req.max_results ?? 5, 20),
    includeDomains: cleanList(req.include_domains),
    excludeDomains: cleanList(req.exclude_domains),
    contents: { text: { maxCharacters: req.include_raw_content ? 4000 : 1200 } },
  };

  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('exa', response.status, payload);

  return {
    id: `xweb_${crypto.randomUUID().slice(0, 8)}`,
    query: req.query,
    provider: 'exa',
    results: (payload?.results ?? []).map((item: any) => ({
      title: item.title ?? 'Untitled',
      url: item.url ?? '',
      snippet: (item.text ?? '').slice(0, 600),
      score: typeof item.score === 'number' ? item.score : undefined,
      published_date: item.publishedDate,
      raw_content: item.text,
    })),
    took_ms: 0,
  };
}

const RUNNERS: Record<ProviderId, (key: string, req: SearchRequest) => Promise<SearchResponse>> = {
  tavily: searchTavily,
  brave: searchBrave,
  serper: searchSerper,
  exa: searchExa,
};

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Talk to a real x-web deployment when XWEB_API_BASE is configured,
 * otherwise fall back to the provider adapters.
 */
export async function runSearch(
  key: string,
  req: SearchRequest,
  options: { apiBase?: string } = {},
): Promise<SearchResponse> {
  if (options.apiBase) {
    const base = options.apiBase.replace(/\/$/, '');
    const response = await fetch(`${base}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new SearchError(
        payload?.error?.message || payload?.message || `x-web returned ${response.status}`,
        response.status === 401 ? 401 : 502,
        'x-web',
      );
    }
    return {
      id: payload.id ?? `xweb_${crypto.randomUUID().slice(0, 8)}`,
      query: payload.query ?? req.query,
      provider: payload.provider ?? 'x-web',
      answer: payload.answer,
      results: Array.isArray(payload.results) ? payload.results : [],
      took_ms: payload.took_ms ?? 0,
    };
  }

  const provider = req.provider ?? 'tavily';
  return RUNNERS[provider](key, req);
}
