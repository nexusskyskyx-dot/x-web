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
  runSearch,
  isProvider,
  rankByFreshness,
  PROVIDER_CAPABILITIES,
  type ProviderId,
  type SearchHit,
  type SearchRequest,
} from './search.ts';
import { synthesizeAnswer, type Answer } from './answer.ts';
import { extractPages, type ExtractedPage } from './extract.ts';

export type QueryRewrite = 'auto' | 'off' | 'force';

export interface PipelineRequest {
  query: string;
  provider?: ProviderId;
  max_results?: number;
  search_depth?: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  include_answer?: boolean;
  include_raw_content?: boolean;
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
}

export interface PipelineResponse {
  id: string;
  object: 'search';
  /** Echo of the caller's query. */
  query: string;
  provider: string;
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
    .map((item) => item.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
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
function chooseQuery(original: string, intent: Intent, mode: QueryRewrite): { query: string; rewritten: boolean } {
  const rewritten = intent.rewritten_query.trim();
  if (mode === 'off' || !rewritten) return { query: original, rewritten: false };
  if (mode === 'force') return { query: rewritten, rewritten: true };

  const originalTokens = original.trim().split(/\s+/).length;
  const rewrittenTokens = rewritten.split(/\s+/).length;
  const worthRewriting = originalTokens >= 5 && rewrittenTokens >= 2 && rewrittenTokens < originalTokens;
  return worthRewriting ? { query: rewritten, rewritten: true } : { query: original, rewritten: false };
}

export async function runPipeline(
  raw: Record<string, unknown>,
  options: { apiKey?: string; queryRewriteDefault?: QueryRewrite } = {},
): Promise<PipelineResponse> {
  const started = Date.now();
  const stages: Record<string, number> = {};

  /* ---------------- validate ---------------- */
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) {
    throw new PipelineError('`query` is required.', 400, 'invalid_request_error', 'missing_query', 'query');
  }
  if (query.length > 2000) {
    throw new PipelineError('`query` must be 2000 characters or fewer.', 400, 'invalid_request_error', 'query_too_long', 'query');
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
  if (raw.search_depth !== undefined && raw.search_depth !== 'basic' && raw.search_depth !== 'advanced') {
    throw new PipelineError(
      '`search_depth` must be "basic" or "advanced".',
      400,
      'invalid_request_error',
      'invalid_search_depth',
      'search_depth',
    );
  }

  const understand = raw.understand !== false;
  const includeAnswer = raw.include_answer !== false;
  const includeRaw = raw.include_raw_content === true;
  const maxResults = clampInt(raw.max_results, 5, 1, MAX_RESULTS);

  const provider = (isProvider(raw.provider) ? raw.provider : undefined) as ProviderId | undefined;
  const resolvedProvider = provider ?? 'tavily';

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
        topic: raw.topic === 'news' ? ('news' as const) : raw.topic === 'general' ? ('general' as const) : undefined,
        time_range: isTimeRange(raw.time_range) ? raw.time_range : undefined,
        country: typeof raw.country === 'string' ? raw.country : undefined,
        include_domains: cleanDomainList(raw.include_domains),
        exclude_domains: cleanDomainList(raw.exclude_domains),
      };

  const rewriteMode: QueryRewrite =
    raw.query_rewrite === 'off' || raw.query_rewrite === 'force'
      ? raw.query_rewrite
      : (options.queryRewriteDefault ?? 'auto');

  const { query: effectiveQuery, rewritten } =
    intent
      ? chooseQuery(query, intent, rewriteMode)
      : { query, rewritten: false };

  /* ---------------- stage 3: retrieve ---------------- */
  const providerRequest: SearchRequest = {
    query: effectiveQuery,
    provider: resolvedProvider,
    max_results: maxResults,
    include_domains: filters.include_domains,
    exclude_domains: filters.exclude_domains,
    // Only ask the provider for raw text when it can supply it; we fetch the
    // rest ourselves in the extract stage.
    include_answer: includeAnswer,
    include_raw_content: includeRaw && PROVIDER_CAPABILITIES[resolvedProvider].rawContent,
    search_depth: raw.search_depth as 'basic' | 'advanced' | undefined,
    topic: filters.topic,
    language: PROVIDER_CAPABILITIES[resolvedProvider].language ? language : undefined,
    country: PROVIDER_CAPABILITIES[resolvedProvider].country ? filters.country : undefined,
    time_range: filters.time_range,
  };

  stageStart = Date.now();
  const search = await runSearch(options.apiKey ?? '', providerRequest, {
    apiBase: env('XWEB_API_BASE'),
  });
  stages.search = Date.now() - stageStart;

  /**
   * What the caller asked for that the provider genuinely cannot do.
   *
   * Computed from the caller's intent rather than from the request we sent
   * downstream, because we deliberately withhold params the provider does not
   * accept — which would otherwise make this list always empty, hiding the
   * problem it exists to surface.
   *
   * Only *filtering* params belong here. `include_answer` and
   * `include_raw_content` are enrichment we perform ourselves regardless of
   * the provider, so they are honoured even on a provider that cannot do them.
   */
  const caps = PROVIDER_CAPABILITIES[resolvedProvider];
  const droppedParams: string[] = [];
  if (filters.time_range && !caps.timeRange) droppedParams.push('time_range');
  // Auto-detection is metadata and does not imply that the caller requested
  // provider-side language filtering. Only flag an explicit language choice.
  if (requestedLanguage.toLowerCase() !== 'auto' && language && !caps.language) {
    droppedParams.push('language');
  }
  if (filters.country && !caps.country) droppedParams.push('country');

  let results = search.results;
  if (filters.time_range && !search.unsupported_params?.includes('time_range')) {
    results = rankByFreshness(results, filters.time_range);
  }

  /* ---------------- stage 4: extract full content ---------------- */
  let extracted: ExtractedPage[] | undefined;
  stageStart = Date.now();

  if (includeRaw) {
    const alreadyHaveText = results.filter(
      (hit) => (hit.raw_content?.length ?? 0) > 200,
    ).length;

    if (alreadyHaveText < results.length) {
      const depth = clampInt(raw.extract_depth, 3, 1, 10);
      const targets = results
        .filter((hit) => (hit.raw_content?.length ?? 0) <= 200)
        .slice(0, depth)
        .map((hit) => hit.url)
        .filter((url) => /^https?:\/\//.test(url));

      if (targets.length > 0) {
        const pages = await extractPages(targets, {
          maxChars: clampInt(env('XWEB_EXTRACT_MAX_CHARS'), 12_000, 500, 100_000),
        });
        extracted = pages;
        // Fold the fetched text back onto the matching results so callers get
        // one place to read it.
        const byUrl = new Map(pages.map((page) => [page.url, page]));
        results = results.map((hit) => {
          const page = byUrl.get(hit.url);
          if (!page?.text) return hit;
          return { ...hit, raw_content: page.text, language: hit.language ?? page.language };
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
    const synthesized = await synthesizeAnswer(query, sources, {
      providerAnswer: search.answer,
      allowLlm: env('XWEB_DISABLE_LLM') !== '1',
    });
    if (synthesized && !synthesized.declined && synthesized.text) answer = synthesized;
  }
  stages.answer = Date.now() - stageStart;

  return {
    id: search.id,
    object: 'search',
    query,
    provider: search.provider,
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
      extracted_count: extracted?.filter((page) => page.text).length ?? 0,
      stages_ms: stages,
    },
  };
}
