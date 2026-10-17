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

import type { TimeRange } from './intent.ts';

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

/**
 * What each provider can actually do. The API reports anything a caller asked
 * for that the selected provider silently ignores — a caller switching from
 * Brave to Exa should find out that its recency window stopped working rather
 * than quietly getting stale results.
 */
export interface ProviderCapabilities {
  /** Can restrict results to a recency window. */
  timeRange: boolean;
  /** Accepts an explicit language parameter. */
  language: boolean;
  /** Accepts a country/region parameter. */
  country: boolean;
  /** Returns its own synthesised answer alongside results. */
  answer: boolean;
  /** Can return full page text, not just a snippet. */
  rawContent: boolean;
  /** Has a first-class domain filter (others fall back to `site:` operators). */
  domainFilter: boolean;
  maxResults: number;
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  tavily: { timeRange: true, language: false, country: true, answer: true, rawContent: true, domainFilter: true, maxResults: 20 },
  brave: { timeRange: true, language: true, country: true, answer: false, rawContent: false, domainFilter: false, maxResults: 20 },
  serper: { timeRange: true, language: true, country: true, answer: true, rawContent: false, domainFilter: false, maxResults: 20 },
  exa: { timeRange: true, language: false, country: false, answer: false, rawContent: true, domainFilter: true, maxResults: 20 },
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
  /** Recency window — "live / current results, not stale training data". */
  time_range?: TimeRange;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  /** Normalised to ISO-8601 (UTC) wherever the provider gives us a date. */
  published_date?: string;
  raw_content?: string;
  /** Detected or provider-reported language of the result. */
  language?: string;
  /** Best-results engine: providers that independently returned this URL. */
  providers?: ProviderId[];
  /** Number of distinct sources that corroborated this result. */
  source_count?: number;
  /** Weighted order score; not a probability or confidence. */
  ranking_score?: number;
  rank_signals?: {
    relevance: number;
    freshness: number;
    authority: number;
    corroboration: number;
  };
}

export interface SearchResponse {
  id: string;
  query: string;
  provider: string;
  answer?: string;
  results: SearchHit[];
  took_ms: number;
  /** Params the caller set that this provider cannot honour. */
  unsupported_params?: string[];
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

/* ------------------------------------------------------------------ */
/* Recency                                                             */
/* ------------------------------------------------------------------ */

const TIME_RANGE_DAYS: Record<TimeRange, number> = { day: 1, week: 7, month: 30, year: 365 };

function rangeToStartDate(range: TimeRange): string {
  const days = TIME_RANGE_DAYS[range] ?? 7;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Brave's freshness codes. */
const BRAVE_FRESHNESS: Record<TimeRange, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

/** Serper's `tbs` recency codes. */
const SERPER_TBS: Record<TimeRange, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

/**
 * Providers report dates in wildly different shapes: ISO strings,
 * "3 days ago", "Dec 18, 2022", "2022-12-18T…". Normalise to ISO-8601 UTC so
 * agents can sort and filter without a parser of their own.
 */
export function normalizePublishedDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();

  const iso = new Date(value);
  if (!Number.isNaN(iso.getTime()) && /\d{4}-\d{2}-\d{2}/.test(value)) {
    const year = iso.getUTCFullYear();
    if (year >= 1990 && year <= new Date().getUTCFullYear() + 1) return iso.toISOString();
  }

  // "3 days ago", "12 hours ago", "2 weeks ago"
  const relative = value.match(/^(\d+)\s+(minute|min|hour|hr|day|week|month|year)s?\s+ago$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms: Record<string, number> = {
      minute: 60_000, min: 60_000,
      hour: 3_600_000, hr: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000,
      year: 31_536_000_000,
    };
    const factor = ms[unit];
    if (factor) return new Date(Date.now() - amount * factor).toISOString();
  }

  // "Dec 18, 2022" / "18 December 2022" / "Dec 2022"
  const textual = new Date(value.replace(/(\d+)\s+([A-Za-z]+)\s+(\d{4})/i, '$2 $1, $3'));
  if (!Number.isNaN(textual.getTime())) {
    const year = textual.getUTCFullYear();
    if (year >= 1990 && year <= new Date().getUTCFullYear() + 1) return textual.toISOString();
  }

  return undefined;
}

/**
 * Nudge recently published results up when the query is time sensitive.
 * Only used when a recency window was requested, so ordinary relevance
 * ordering is left untouched.
 */
export function rankByFreshness(hits: SearchHit[], range: TimeRange): SearchHit[] {
  const windowMs = TIME_RANGE_DAYS[range] * 86_400_000;
  const now = Date.now();

  return hits
    .map((hit, index) => {
      let boost = 1;
      if (hit.published_date) {
        const age = now - new Date(hit.published_date).getTime();
        if (Number.isFinite(age) && age >= 0 && age <= windowMs) {
          // 1.0 at the edge of the window, 1.6 for something published now.
          boost += 0.6 * (1 - age / windowMs);
        }
      }
      return { hit, index, weight: boost / (1 + index * 0.02) };
    })
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.hit);
}

/** Params the caller asked for that this provider will silently drop. */
export function unsupportedParams(req: SearchRequest, provider: ProviderId): string[] {
  const caps = PROVIDER_CAPABILITIES[provider];
  const dropped: string[] = [];
  if (req.time_range && !caps.timeRange) dropped.push('time_range');
  if (req.language && !caps.language) dropped.push('language');
  if (req.country && !caps.country) dropped.push('country');
  if (req.include_raw_content && !caps.rawContent) dropped.push('include_raw_content');
  if (req.include_answer && !caps.answer) dropped.push('include_answer');
  if ((req.include_domains?.length || req.exclude_domains?.length) && !caps.domainFilter) {
    // Brave and Serper still honour these via `site:` operators, so this is
    // a capability note rather than a dropped parameter.
  }
  return dropped;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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

function newId(): string {
  return `xweb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
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

  // Tavily only applies `days` to the news topic, so a recency window implies
  // news here. Documented on /docs/providers.
  if (req.time_range) {
    body.topic = 'news';
    body.days = TIME_RANGE_DAYS[req.time_range];
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('tavily', response.status, payload);

  return {
    id: newId(),
    query: payload.query ?? req.query,
    provider: 'tavily',
    answer: payload.answer || undefined,
    results: (payload.results ?? []).map((item: any) => ({
      title: item.title ?? 'Untitled',
      url: item.url ?? '',
      snippet: item.content ?? '',
      score: typeof item.score === 'number' ? item.score : undefined,
      published_date: normalizePublishedDate(item.published_date),
      raw_content: item.raw_content,
    })),
    took_ms: 0,
    unsupported_params: unsupportedParams(req, 'tavily'),
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
  if (req.time_range) url.searchParams.set('freshness', BRAVE_FRESHNESS[req.time_range]);
  url.searchParams.set('extra_snippets', 'true');

  const response = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('brave', response.status, payload);

  return {
    id: newId(),
    query: req.query,
    provider: 'brave',
    results: (payload?.web?.results ?? []).map((item: any) => ({
      title: item.title ?? 'Untitled',
      url: item.url ?? '',
      snippet: item.description ?? '',
      score: undefined,
      published_date: normalizePublishedDate(item.page_age ?? item.age),
      language: typeof item.language === 'string' ? item.language : undefined,
    })),
    took_ms: 0,
    unsupported_params: unsupportedParams(req, 'brave'),
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
  if (req.time_range) body.tbs = SERPER_TBS[req.time_range];

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
    published_date: normalizePublishedDate(item.date),
  }));

  if (answerBox?.link && !results.some((r) => r.url === answerBox.link)) {
    results.unshift({
      title: answerBox.title ?? 'Answer',
      url: answerBox.link ?? '',
      snippet: answerBox.snippet ?? answerBox.answer ?? '',
    });
  }

  return {
    id: newId(),
    query: req.query,
    provider: 'serper',
    answer,
    results,
    took_ms: 0,
    unsupported_params: unsupportedParams(req, 'serper'),
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
  if (req.time_range) body.startPublishedDate = rangeToStartDate(req.time_range);

  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const payload = await readJson(response);
  if (!response.ok) throw upstreamError('exa', response.status, payload);

  return {
    id: newId(),
    query: req.query,
    provider: 'exa',
    results: (payload?.results ?? []).map((item: any) => ({
      title: item.title ?? 'Untitled',
      url: item.url ?? '',
      snippet: (item.text ?? '').slice(0, 600),
      score: typeof item.score === 'number' ? item.score : undefined,
      published_date: normalizePublishedDate(item.publishedDate),
      raw_content: item.text,
    })),
    took_ms: 0,
    unsupported_params: unsupportedParams(req, 'exa'),
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
      id: payload.id ?? newId(),
      query: payload.query ?? req.query,
      provider: payload.provider ?? 'x-web',
      answer: payload.answer,
      results: Array.isArray(payload.results) ? payload.results : [],
      took_ms: payload.took_ms ?? 0,
    };
  }

  const provider = req.provider ?? 'tavily';
  const result = await RUNNERS[provider](key, req);

  if (req.time_range) {
    result.results = rankByFreshness(result.results, req.time_range);
  }
  return result;
}
