/**
 * The x-web search pipeline.
 *
 * One call takes a natural-language question and returns live results, a
 * synthesised answer with citations, and the extracted page content — plus the
 * interpretation it used to get there, so an agent can inspect and correct it.
 *
 *   understand → rewrite → retrieve → (extract) → (answer) → respond
 *
 * Every stage is optional and independently useful, which is why they are also
 * exposed as their own endpoints (/api/v1/intent, /api/v1/extract).
 */

import { env } from './env.ts';
import { resolveLanguage, type LanguageGuess } from './lang.ts';
import {
  understandQuery,
  mergeIntentWithRequest,
  isTimeRange,
  type Intent,
  type TimeRange,
} from './intent.ts';
import {
  isProvider,
  PROVIDERS,
  PROVIDER_META,
  type ProviderId,
  type SearchHit,
  type SearchRequest,
} from './search.ts';
import {
  planResearchQueries,
  synthesizeAnswer,
  synthesizeResearchReport,
  type Answer,
} from './answer.ts';
import type { AiRuntimeConfig } from './ai-credentials.ts';
import { extractPages, type ExtractedPage } from './extract.ts';
import {
  searchAcrossProviders,
  type FederatedSearchResponse,
  type ProviderFailure,
} from './federation.ts';
import { rankAndBlend } from './ranking.ts';

export type QueryRewrite = 'auto' | 'off' | 'force';

export interface PipelineRequest {
  query: string;
  mode?: 'standard' | 'deep';
  provider?: ProviderId;
  /** Legacy fan-out control when mode is omitted; explicit deep mode always federates. */
  multi_source?: boolean;
  /** Optional provider allow-list for a federated search. */
  providers?: ProviderId[];
  max_results?: number;
  search_depth?: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  include_answer?: boolean;
  include_raw_content?: boolean;
  include_images?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
  /** BCP-47 tag, or "auto" (default) to detect from the query. */
  language?: string;
  /** ISO-3166-1 alpha-2, e.g. "US". */
  country?: string;
  time_range?: TimeRange;
  /** Run query understanding. Default true. */
  understand?: boolean;
  /** How to apply the rewritten query. Default "auto". */
  query_rewrite?: QueryRewrite;
  /** How many results to fetch full text for. Default 3, max 10. */
  extract_depth?: number;
}

export interface PipelineMeta {
  /** The query actually sent to the provider (may differ from the input). */
  effective_query: string;
  rewritten: boolean;
  time_sensitive: boolean;
  extracted_count: number;
  stages_ms: Record<string, number>;
  research?: {
    mode: 'standard' | 'deep';
    subqueries: string[];
    pages_attempted: number;
    pages_read: number;
    failed_subqueries?: string[];
  };
}

export interface PipelineResponse {
  id: string;
  object: 'search';
  /** Echo of the caller's query. */
  query: string;
  mode: 'standard' | 'deep';
  /** Present for deep mode; Markdown report with inline citation markers. */
  report?: string;
  /** Inline citations referenced by `report`. */
  citations?: Answer['citations'];
  provider: string;
  providers_used: ProviderId[];
  provider_errors?: ProviderFailure[];
  unavailable_providers?: ProviderId[];
  took_ms: number;
  language: {
    requested: string;
    resolved: string;
    detected: LanguageGuess;
  };
  intent?: Intent;
  answer?: Answer;
  results: SearchHit[];
  extracted?: ExtractedPage[];
  /** Params the chosen provider could not honour. */
  unsupported_params?: string[];
  meta: PipelineMeta;
}

export class PipelineError extends Error {
  status: number;
  type: string;
  code: string;
  param?: string;
  constructor(message: string, status: number, type: string, code: string, param?: string) {
    super(message);
    this.name = 'PipelineError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

const MAX_RESULTS = 20;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function cleanDomainList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) =>
      item
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, ''),
    )
    .filter(Boolean);
  return list.length > 0 ? [...new Set(list)].slice(0, 50) : undefined;
}

/**
 * Decide whether to send the stripped-down query or the original.
 *
 * Modern indexes handle full questions well, so rewriting only pays off on
 * verbose queries ("hey, can you tell me what the model context protocol is").
 * `auto` therefore rewrites only when the original is wordy and the rewrite
 * keeps enough signal to be safe.
 */
function chooseQuery(
  original: string,
  intent: Intent,
  mode: QueryRewrite,
): { query: string; rewritten: boolean } {
  const rewritten = intent.rewritten_query.trim();
  if (mode === 'off' || !rewritten) return { query: original, rewritten: false };
  if (mode === 'force') return { query: rewritten, rewritten: true };

  const originalTokens = original.trim().split(/\s+/).length;
  const rewrittenTokens = rewritten.split(/\s+/).length;
  const worthRewriting =
    originalTokens >= 5 && rewrittenTokens >= 2 && rewrittenTokens < originalTokens;
  return worthRewriting
    ? { query: rewritten, rewritten: true }
    : { query: original, rewritten: false };
}

export async function runPipeline(
  raw: Record<string, unknown>,
  options: {
    apiKey?: string;
    providerKeys?: Partial<Record<ProviderId, string>>;
    aiConfig?: AiRuntimeConfig;
    queryRewriteDefault?: QueryRewrite;
  } = {},
): Promise<PipelineResponse> {
  const started = Date.now();
  const stages: Record<string, number> = {};

  /* ---------------- validate ---------------- */
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) {
    throw new PipelineError(
      '`query` is required.',
      400,
      'invalid_request_error',
      'missing_query',
      'query',
    );
  }
  if (query.length > 2000) {
    throw new PipelineError(
      '`query` must be 2000 characters or fewer.',
      400,
      'invalid_request_error',
      'query_too_long',
      'query',
    );
  }

  if (raw.mode !== undefined && raw.mode !== 'standard' && raw.mode !== 'deep') {
    throw new PipelineError(
      '`mode` must be \"standard\" or \"deep\".',
      400,
      'invalid_request_error',
      'invalid_mode',
      'mode',
    );
  }
  if (raw.provider !== undefined && !isProvider(raw.provider)) {
    throw new PipelineError(
      `\`provider\` must be one of: tavily, brave, serper, exa.`,
      400,
      'invalid_request_error',
      'invalid_provider',
      'provider',
    );
  }
  if (raw.multi_source !== undefined && typeof raw.multi_source !== 'boolean') {
    throw new PipelineError(
      '`multi_source` must be a boolean.',
      400,
      'invalid_request_error',
      'invalid_multi_source',
      'multi_source',
    );
  }
  if (
    raw.providers !== undefined &&
    (!Array.isArray(raw.providers) || raw.providers.some((p) => !isProvider(p)))
  ) {
    throw new PipelineError(
      '`providers` must contain only supported provider names.',
      400,
      'invalid_request_error',
      'invalid_providers',
      'providers',
    );
  }
  if (raw.time_range !== undefined && !isTimeRange(raw.time_range)) {
    throw new PipelineError(
      '`time_range` must be one of: day, week, month, year.',
      400,
      'invalid_request_error',
      'invalid_time_range',
      'time_range',
    );
  }
  if (raw.topic !== undefined && raw.topic !== 'general' && raw.topic !== 'news') {
    throw new PipelineError(
      '`topic` must be "general" or "news".',
      400,
      'invalid_request_error',
      'invalid_topic',
      'topic',
    );
  }
  if (
    raw.search_depth !== undefined &&
    raw.search_depth !== 'basic' &&
    raw.search_depth !== 'advanced'
  ) {
    throw new PipelineError(
      '`search_depth` must be "basic" or "advanced".',
      400,
      'invalid_request_error',
      'invalid_search_depth',
      'search_depth',
    );
  }

  const mode = (raw.mode ?? 'standard') as 'standard' | 'deep';
  if (mode === 'deep' && !options.aiConfig) {
    throw new PipelineError(
      'Deep mode requires a saved BYOK AI provider credential for query planning and report generation.',
      400,
      'invalid_request_error',
      'deep_mode_requires_ai_key',
      'mode',
    );
  }
  const understand = raw.understand !== false;
  const includeAnswer =
    mode === 'deep' ||
    (raw.mode === undefined ? raw.include_answer !== false : raw.include_answer === true);
  const includeRaw = raw.include_raw_content === true || mode === 'deep';
  const includeImages = raw.include_images === true;
  const maxResults = clampInt(raw.max_results, mode === 'deep' ? 10 : 5, 1, MAX_RESULTS);

  const provider = (isProvider(raw.provider) ? raw.provider : undefined) as ProviderId | undefined;
  const configuredDefault = env('XWEB_SEARCH_PROVIDER');
  const configuredDefaultWithKey =
    isProvider(configuredDefault) &&
    Boolean(env('XWEB_SEARCH_API_KEY') || env(PROVIDER_META[configuredDefault].envVar))
      ? configuredDefault
      : undefined;
  const firstAvailableProvider = PROVIDERS.find((id) =>
    Boolean(options.providerKeys?.[id] || env(PROVIDER_META[id].envVar)),
  );
  const resolvedProvider =
    provider ??
    configuredDefaultWithKey ??
    (options.apiKey ? 'tavily' : firstAvailableProvider) ??
    (isProvider(configuredDefault) ? configuredDefault : 'tavily');

  /* ---------------- stage 1: understand ---------------- */
  let stageStart = Date.now();
  const intent = understand ? understandQuery(query) : undefined;

  const requestedLanguage = typeof raw.language === 'string' ? raw.language : 'auto';
  const { language, detected } = resolveLanguage(requestedLanguage, query);
  stages.understand = Date.now() - stageStart;

  /* ---------------- stage 2: merge filters ---------------- */
  const filters = intent
    ? mergeIntentWithRequest(intent, {
        topic: typeof raw.topic === 'string' ? raw.topic : undefined,
        time_range: isTimeRange(raw.time_range) ? raw.time_range : undefined,
        country: typeof raw.country === 'string' ? raw.country : undefined,
        include_domains: cleanDomainList(raw.include_domains),
        exclude_domains: cleanDomainList(raw.exclude_domains),
      })
    : {
        topic:
          raw.topic === 'news'
            ? ('news' as const)
            : raw.topic === 'general'
              ? ('general' as const)
              : undefined,
        time_range: isTimeRange(raw.time_range) ? raw.time_range : undefined,
        country: typeof raw.country === 'string' ? raw.country : undefined,
        include_domains: cleanDomainList(raw.include_domains),
        exclude_domains: cleanDomainList(raw.exclude_domains),
      };

  const rewriteMode: QueryRewrite =
    raw.query_rewrite === 'off' || raw.query_rewrite === 'force'
      ? raw.query_rewrite
      : (options.queryRewriteDefault ?? 'auto');

  const { query: effectiveQuery, rewritten } = intent
    ? chooseQuery(query, intent, rewriteMode)
    : { query, rewritten: false };

  /* ---------------- stage 3: retrieve ---------------- */
  const providerRequest: SearchRequest = {
    query: effectiveQuery,
    provider: resolvedProvider,
    max_results: maxResults,
    include_domains: filters.include_domains,
    exclude_domains: filters.exclude_domains,
    include_answer: includeAnswer,
    include_raw_content: includeRaw,
    search_depth: raw.search_depth as 'basic' | 'advanced' | undefined,
    topic: filters.topic,
    language,
    country: filters.country,
    time_range: filters.time_range,
  };

  const planStart = Date.now();
  const subqueries =
    mode === 'deep' ? await planResearchQueries(query, options.aiConfig) : [effectiveQuery];
  stages.plan = Date.now() - planStart;
  stageStart = Date.now();
  const searchOptions = {
    apiBase: env('XWEB_API_BASE'),
    primaryProvider: resolvedProvider,
    primaryKey: options.apiKey ?? '',
    multiSource: mode === 'deep' || (raw.mode === undefined && raw.multi_source !== false),
    explicitLanguage:
      typeof raw.language === 'string' &&
      Boolean(raw.language.trim()) &&
      raw.language.toLowerCase() !== 'auto',
    requestedProviders:
      (mode === 'deep' || raw.mode === undefined) && Array.isArray(raw.providers)
        ? (raw.providers as ProviderId[])
        : undefined,
    providerKeys: options.providerKeys,
  };
  let search: FederatedSearchResponse;
  let failedSubqueries: string[] = [];
  if (mode === 'deep') {
    const perQueryRequest = {
      ...providerRequest,
      max_results: Math.max(maxResults, 10),
    };
    const outcomes = await Promise.allSettled(
      subqueries.map((subquery) =>
        searchAcrossProviders({ ...perQueryRequest, query: subquery }, searchOptions),
      ),
    );
    const successful = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    failedSubqueries = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected' ? [subqueries[index]] : [],
    );
    if (!successful.length) {
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      throw new Error('All research searches failed.');
    }
    const hitsByProvider = new Map<ProviderId, SearchHit[]>();
    for (const response of successful) {
      for (const hit of response.results) {
        for (const providerId of hit.providers ?? response.providers_used) {
          const hits = hitsByProvider.get(providerId) ?? [];
          hits.push(hit);
          hitsByProvider.set(providerId, hits);
        }
      }
    }
    const providers_used = [...new Set(successful.flatMap((response) => response.providers_used))];
    const results = rankAndBlend(
      query,
      [...hitsByProvider].map(([providerId, hits]) => ({
        provider: providerId,
        results: hits,
      })),
      { maxResults },
    );
    const provider_errors = [
      ...new Map(
        successful
          .flatMap((response) => response.provider_errors ?? [])
          .map((failure) => [`${failure.provider}:${failure.message}`, failure]),
      ).values(),
    ];
    const unavailable_providers = [
      ...new Set(successful.flatMap((response) => response.unavailable_providers ?? [])),
    ];
    search = {
      id: `xweb_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      query: effectiveQuery,
      provider: providers_used.length > 1 ? 'multi' : providers_used[0],
      providers_used,
      ...(provider_errors.length ? { provider_errors } : {}),
      ...(unavailable_providers.length ? { unavailable_providers } : {}),
      ...(successful.find((response) => response.answer)?.answer
        ? { answer: successful.find((response) => response.answer)?.answer }
        : {}),
      results,
      took_ms: Math.max(...successful.map((response) => response.took_ms)),
      ...(successful.some((response) => response.unsupported_params?.length)
        ? {
            unsupported_params: [
              ...new Set(successful.flatMap((response) => response.unsupported_params ?? [])),
            ],
          }
        : {}),
    };
  } else {
    search = await searchAcrossProviders(providerRequest, {
      ...searchOptions,
      multiSource: raw.mode === undefined ? raw.multi_source !== false : false,
    });
  }
  stages.search = Date.now() - stageStart;

  // Only filtering preferences count as unsupported: answer synthesis and page
  // extraction are x-web enrichment and can still be provided independently.
  const droppedParams = search.unsupported_params ?? [];
  let results = search.results;

  /* ---------------- stage 4: extract full content ---------------- */
  let extracted: ExtractedPage[] | undefined;
  let pagesAttempted = 0;
  stageStart = Date.now();

  if (includeRaw || includeImages) {
    const depth = mode === 'deep' ? 10 : clampInt(raw.extract_depth, 3, 1, 10);
    const targets = results
      .filter((hit) => mode === 'deep' || includeImages || (hit.raw_content?.length ?? 0) <= 200)
      .slice(0, depth)
      .map((hit) => hit.url)
      .filter((url) => /^https?:\/\//.test(url));
    pagesAttempted = targets.length;

    if (targets.length > 0) {
      const pages = await extractPages(targets, {
        maxChars: clampInt(env('XWEB_EXTRACT_MAX_CHARS'), 12_000, 500, 100_000),
        includeImages,
      });
      extracted = includeRaw
        ? pages
        : pages.map((page) => {
            const { text: _text, word_count: _wordCount, ...metadata } = page;
            return metadata;
          });
      // Fold fetched text back onto the results only when requested; image-only
      // extraction should not unexpectedly expand every result with page text.
      if (includeRaw) {
        const byUrl = new Map(pages.map((page) => [page.url, page]));
        results = results.map((hit) => {
          const page = byUrl.get(hit.url);
          if (!page?.text) return hit;
          return {
            ...hit,
            raw_content: page.text,
            language: hit.language ?? page.language,
          };
        });
      }
    }
  }
  stages.extract = Date.now() - stageStart;

  /* ---------------- stage 5: answer ---------------- */
  stageStart = Date.now();
  let answer: Answer | undefined;
  if (includeAnswer) {
    const sources = results.map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      raw_content: hit.raw_content,
    }));
    const synthesized =
      mode === 'deep'
        ? await synthesizeResearchReport(query, sources.slice(0, 10), options.aiConfig)
        : await synthesizeAnswer(query, sources, {
            providerAnswer: search.answer,
            allowLlm: env('XWEB_DISABLE_LLM') !== '1',
            aiConfig: options.aiConfig,
          });
    if (synthesized && !synthesized.declined && synthesized.text) answer = synthesized;
    if (mode === 'deep' && !answer) {
      throw new PipelineError(
        'Deep Research could not generate a cited report from the available sources. Try again or check your saved BYOK model configuration.',
        502,
        'upstream_error',
        'deep_report_generation_failed',
        'mode',
      );
    }
  }
  stages.answer = Date.now() - stageStart;

  return {
    id: search.id,
    object: 'search',
    query,
    mode,
    ...(mode === 'deep' && answer ? { report: answer.text, citations: answer.citations } : {}),
    provider: search.provider,
    providers_used: search.providers_used,
    ...(search.provider_errors ? { provider_errors: search.provider_errors } : {}),
    ...(search.unavailable_providers
      ? { unavailable_providers: search.unavailable_providers }
      : {}),
    took_ms: Date.now() - started,
    language: {
      requested: requestedLanguage,
      resolved: language,
      detected,
    },
    ...(intent ? { intent } : {}),
    ...(answer ? { answer } : {}),
    results,
    ...(extracted && extracted.length > 0 ? { extracted } : {}),
    unsupported_params: droppedParams.length > 0 ? droppedParams : undefined,
    meta: {
      effective_query: effectiveQuery,
      rewritten,
      time_sensitive: Boolean(filters.time_range),
      extracted_count:
        extracted?.filter((page) => page.text || (page.images?.length ?? 0) > 0).length ?? 0,
      stages_ms: stages,
      ...(mode === 'deep'
        ? {
            research: {
              mode,
              subqueries,
              pages_attempted: pagesAttempted,
              pages_read: extracted?.filter((page) => Boolean(page.text)).length ?? 0,
              failed_subqueries: failedSubqueries,
            },
          }
        : {
            research: {
              mode,
              subqueries: [],
              pages_attempted: 0,
              pages_read: 0,
            },
          }),
    },
  };
}
