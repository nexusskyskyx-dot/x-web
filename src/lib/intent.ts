/**
 * Query understanding: natural language → structured search intent.
 *
 * An agent asks "what's the latest on the MCP spec and how does it compare to
 * function calling?" — but a web index wants a tight keyword query, a news
 * filter and a recency window. This module bridges that gap.
 *
 * It is rule-based on purpose. There is no network call and no per-request
 * cost, it is deterministic (so it is testable and debuggable), and it runs
 * in well under a millisecond. The `signals` array records exactly which rules
 * fired, so a caller can see *why* the query was rewritten the way it was
 * instead of trusting an opaque transformation.
 *
 * If an LLM is configured the pipeline can refine this, but the rules are the
 * baseline that always works.
 */

import { detectLanguage, type LanguageGuess } from './lang.ts';
import { keywords } from './text.ts';

export type IntentType =
  | 'definition'
  | 'question'
  | 'news'
  | 'comparison'
  | 'howto'
  | 'code'
  | 'shopping'
  | 'local'
  | 'navigational'
  | 'research'
  | 'search';

export type TimeRange = 'day' | 'week' | 'month' | 'year';

export interface Entity {
  text: string;
  type:
    | 'quoted'
    | 'proper_noun'
    | 'year'
    | 'money'
    | 'version'
    | 'domain'
    | 'quantity'
    | 'handle'
    | 'hashtag';
}

export interface IntentFilters {
  topic?: 'general' | 'news';
  time_range?: TimeRange;
  country?: string;
  include_domains?: string[];
  exclude_domains?: string[];
}

export interface Intent {
  type: IntentType;
  /** 0..1 */
  confidence: number;
  /** Terms worth sending to the index, most significant first. */
  keywords: string[];
  entities: Entity[];
  /** True when the answer could be stale — drives `filters.time_range`. */
  time_sensitive: boolean;
  language: LanguageGuess;
  /** The query rewritten for a search index, not for a human. */
  rewritten_query: string;
  /** Suggested provider parameters derived from the phrasing. */
  filters: IntentFilters;
  /** Rule names that fired — the "why" behind this interpretation. */
  signals: string[];
}

/* ------------------------------------------------------------------ */
/* Rule tables                                                         */
/* ------------------------------------------------------------------ */

interface Rule {
  type: IntentType;
  signal: string;
  test: RegExp;
  weight: number;
}

/**
 * Ordered by specificity: `navigational` and `definition` are checked before
 * the generic `question`, because "what is the login page" is navigational
 * rather than a request for a definition.
 */
const RULES: Rule[] = [
  {
    type: 'navigational',
    signal: 'navigational_phrase',
    test: /\b(log\s?in|sign\s?in|log\s?on|download|install\s?er|official\s+(site|website|page)|pricing\s+page|documentation|docs|changelog|status\s+page|github\.com|npmjs\.com)\b/i,
    weight: 3,
  },
  {
    type: 'definition',
    signal: 'definition_phrase',
    test: /\b(what\s+is|what\s+are|what\s+was|what's|who\s+is|who\s+was|who's|define|definition\s+of|meaning\s+of|what\s+does\s+.+\s+mean|explain)\b/i,
    weight: 3,
  },
  {
    type: 'howto',
    signal: 'howto_phrase',
    test: /\b(how\s+to|how\s+do\s+i|how\s+can\s+i|how\s+do\s+you|steps\s+to|guide\s+to|tutorial|walkthrough|set\s?up|install|configure|deploy|migrate|fix|troubleshoot)\b/i,
    weight: 3,
  },
  {
    type: 'comparison',
    signal: 'comparison_phrase',
    // Weight 4: an explicit comparison marker is close to unambiguous, whereas
    // the navigational and shopping markers below are words ("docs", "review")
    // that also appear as ordinary subject matter. Without the higher weight
    // "Tailwind vs Bootstrap for a docs site" classified as navigational.
    // The lookahead stops "vs code" (Visual Studio Code) reading as "versus".
    test: /(\bvs\.?\b(?!\s+code\b)|\bversus\b|\bcompare[ds]?\b|\bcomparison\b|\bdifference\s+between\b|\bbetter\s+than\b|\bworse\s+than\b|\bor\b.*\bwhich\b|\bpros\s+and\s+cons\b|\balternatives?\b|\binstead\s+of\b)/i,
    weight: 4,
  },
  {
    type: 'shopping',
    signal: 'shopping_phrase',
    test: /\b(buy|purchase|price|prices|pricing|cost|costs|cheap(?:est)?|discount|deal|deals|for\s+sale|under\s*[$€£¥]|best\s+.{0,30}\b(to\s+buy|under|for)\b|review|reviews|black\s+friday)\b/i,
    weight: 2,
  },
  {
    type: 'code',
    signal: 'code_phrase',
    test: /(\berror\b|\bexception\b|\bstack\s?trace\b|\bundefined\b|\bnull\s?pointer\b|\bsegmentation\s+fault\b|\btraceback\b|\bfunction\b|\bclass\b|\bmodule\s+not\s+found\b|\bimport\s+error\b|\bnpm\b|\bpypi\b|\bpip\s+install\b|\bpython\b|\bjavascript\b|\btypescript\b|\brust\b|\bgolang\b|\bsql\b|\bregex\b|\bapi\s+(key|endpoint|reference|call)\b|\bcompile|runtime\s+error\b|\bdebug\b)/i,
    weight: 2,
  },
  {
    type: 'local',
    signal: 'local_phrase',
    test: /\b(near\s+me|nearby|near\s+my|closest|in\s+my\s+area|open\s+now|opening\s+hours|restaurants?\s+in|hotels?\s+in|coffee\s+shops?\s+in|directions\s+to)\b/i,
    weight: 3,
  },
  {
    type: 'research',
    signal: 'research_phrase',
    test: /\b(arxiv|paper|papers|study|studies|research|journal|peer[\s-]reviewed|meta[\s-]analysis|according\s+to|statistics|dataset|whitepaper|citation|thesis)\b/i,
    weight: 2,
  },
  {
    type: 'news',
    signal: 'news_phrase',
    test: /\b(news|headlines?|breaking|latest|just\s+(released|announced|published|launched)|announced|announcement|today|this\s+week|this\s+morning|rumou?r|leak(?:ed)?)\b/i,
    // Specific freshness language should win over a generic "what is" frame.
    weight: 4,
  },
  {
    type: 'question',
    signal: 'question_form',
    test: /^\s*(who|what|when|where|why|which|whose|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|am)\b/i,
    weight: 1,
  },
  { type: 'question', signal: 'question_mark', test: /\?\s*$/, weight: 1 },
];

/** Phrasing that implies how fresh the answer needs to be. */
const RECENCY: Array<{ signal: string; range: TimeRange; test: RegExp }> = [
  { signal: 'recency_today', range: 'day', test: /\b(today|tonight|this\s+morning|last\s+24\s*h(?:ours)?|just\s+now|right\s+now|breaking)\b/i },
  { signal: 'recency_week', range: 'week', test: /\b(yesterday|this\s+week|past\s+week|last\s+week|last\s+7\s*days|past\s+7\s*days|few\s+days)\b/i },
  { signal: 'recency_month', range: 'month', test: /\b(this\s+month|past\s+month|last\s+30\s*days|last\s+month|past\s+30\s*days|recent(?:ly)?)\b/i },
  { signal: 'recency_year', range: 'year', test: /\b(this\s+year|past\s+year|last\s+year|20[2-5]\d)\b/i },
];

/**
 * Filler an index does not want. Question scaffolding adds tokens that match
 * boilerplate on nearly every page, diluting the terms that actually matter.
 */
const FILLER =
  /\b(please|could\s+you|can\s+you|would\s+you|i\s+want\s+to\s+know|i\s+need\s+to\s+know|tell\s+me|show\s+me|explain\s+to\s+me|give\s+me|find\s+me|let\s+me\s+know|i'?m\s+wondering|do\s+you\s+know|thanks|thank\s+you|hey|hi|hello|search\s+for|look\s+up|google)\b/gi;

const QUESTION_SCAFFOLD =
  /\b(what|which|who|whom|whose|where|when|why|how)\s+(is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|am)\b/gi;

const HEDGE = /\b(the|a|an|of|for|to|in|on|at|by|with|some|any|me|you|your|please)\b/gi;

const COUNTRIES: Record<string, string> = {
  'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'england': 'GB',
  'canada': 'CA', 'australia': 'AU', 'new zealand': 'NZ',
  'germany': 'DE', 'deutschland': 'DE', 'france': 'FR', 'spain': 'ES',
  'italy': 'IT', 'portugal': 'PT', 'netherlands': 'NL', 'holland': 'NL',
  'belgium': 'BE', 'switzerland': 'CH', 'austria': 'AT',
  'sweden': 'SE', 'norway': 'NO', 'denmark': 'DK', 'finland': 'FI',
  'poland': 'PL', 'ireland': 'IE', 'brazil': 'BR', 'mexico': 'MX',
  'argentina': 'AR', 'japan': 'JP', 'china': 'CN', 'india': 'IN',
  'south korea': 'KR', 'korea': 'KR', 'singapore': 'SG',
  'guatemala': 'GT', 'colombia': 'CO', 'chile': 'CL', 'peru': 'PE',
};

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

function extractEntities(query: string): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  const push = (text: string, type: Entity['type']) => {
    const key = `${type}:${text.toLowerCase()}`;
    if (seen.has(key) || text.length < 2) return;
    seen.add(key);
    out.push({ text: text.trim(), type });
  };

  // Quoted phrases first — the most explicit signal a user can give.
  for (const m of query.matchAll(/"([^"]{2,80})"|'([^']{2,80})'/g)) {
    push(m[1] ?? m[2], 'quoted');
  }

  for (const m of query.matchAll(/\b(\d{4})\b/g)) push(m[1], 'year');
  for (const m of query.matchAll(/[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:usd|eur|gbp|jpy|dollars?|euros?)\b/gi)) {
    push(m[0], 'money');
  }
  for (const m of query.matchAll(/\bv?\d+(?:\.\d+){1,3}\b/gi)) push(m[0], 'version');
  for (const m of query.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|gov|edu|de|fr|uk|jp|br|gt)\b/gi)) {
    push(m[0], 'domain');
  }
  for (const m of query.matchAll(/\b\d[\d,.]*\s?(?:gb|mb|tb|kb|kg|g|mg|ml|l|km|mi|m|ft|in|hz|ghz|mhz|w|kw|ms|s|min|hours?|years?|months?|days?)\b/gi)) {
    push(m[0], 'quantity');
  }
  for (const m of query.matchAll(/@[a-z0-9_]{2,30}\b/gi)) push(m[0], 'handle');
  for (const m of query.matchAll(/#[a-z0-9_]{2,40}\b/gi)) push(m[0], 'hashtag');

  // Proper nouns: capitalised runs, allowing internal dots/hyphens/ampersands
  // ("Model Context Protocol", "Node.js", "AT&T"). Skipped at sentence start
  // where capitalisation carries no information.
  const withoutQuoted = query.replace(/"[^"]*"|'[^']*'/g, ' ');
  for (const m of withoutQuoted.matchAll(/\b([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,4})\b/g)) {
    const text = m[1].trim();
    const isSentenceStart = m.index === 0;
    if (isSentenceStart && /^[A-Z][a-z]+$/.test(text.split(/\s+/)[0]) && text.split(/\s+/).length === 1) {
      continue;
    }
    if (/^(I|A|An|The|And|Or|But|If|When|What|Who|How|Why|Where|Which|Is|Are|Do|Does|Can|Should|Will|Please|Tell|Show|Give|Find|Search|Look)$/.test(text)) {
      continue;
    }
    push(text, 'proper_noun');
  }

  return out;
}

function extractDomainFilters(query: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const m of query.matchAll(/(-?)site:\s?([a-z0-9.-]+)/gi)) {
    const domain = m[2].replace(/^www\./, '');
    if (!domain) continue;
    (m[1] === '-' ? exclude : include).push(domain);
  }
  return { include: [...new Set(include)], exclude: [...new Set(exclude)] };
}

function extractCountry(query: string): string | undefined {
  const lower = query.toLowerCase();
  // longest first so "united states" beats "us"
  for (const name of Object.keys(COUNTRIES).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?:^|\\s|(?:in|for|from)\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$|[,.?!])`);
    if (re.test(lower)) return COUNTRIES[name];
  }
  return undefined;
}

/** Strip scaffolding, keep the terms an index can actually use. */
function rewriteQuery(query: string, entities: Entity[]): string {
  let text = query;

  text = text.replace(/(-?site:\s?[a-z0-9.-]+)/gi, ' ');
  text = text.replace(FILLER, ' ');
  text = text.replace(QUESTION_SCAFFOLD, ' ');
  text = text.replace(HEDGE, ' ');
  text = text.replace(/[?!]+/g, ' ');

  // Stopword-stripped keywords, but never throw away an entity.
  const terms = keywords(text, 10);
  const entityTerms = entities
    .filter((e) => e.type !== 'hashtag')
    .flatMap((e) => keywords(e.text, 4));

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const term of [...entityTerms, ...terms]) {
    if (seen.has(term)) continue;
    seen.add(term);
    merged.push(term);
  }

  const rewritten = merged.join(' ').trim();
  if (rewritten.length < 2) return query.trim().replace(/\s+/g, ' ');

  // Do not let aggressive stripping make the query worse than the original.
  const originalTerms = keywords(query, 20);
  if (originalTerms.length >= 3 && merged.length <= 1) {
    return keywords(query, 8).join(' ');
  }
  return rewritten;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function understandQuery(query: string): Intent {
  const raw = (query ?? '').trim();
  const signals: string[] = [];

  if (!raw) {
    return {
      type: 'search',
      confidence: 0,
      keywords: [],
      entities: [],
      time_sensitive: false,
      language: detectLanguage(''),
      rewritten_query: '',
      filters: {},
      signals: ['empty_query'],
    };
  }

  /* --- intent type: highest-weight matching rule wins --- */
  const scores = new Map<IntentType, number>();
  for (const rule of RULES) {
    if (!rule.test.test(raw)) continue;
    scores.set(rule.type, (scores.get(rule.type) ?? 0) + rule.weight);
    signals.push(rule.signal);
  }

  let type: IntentType = 'search';
  let bestScore = 0;
  for (const [candidate, score] of scores) {
    if (score > bestScore) {
      type = candidate;
      bestScore = score;
    }
  }
  if (bestScore === 0) signals.push('no_rule_matched');

  /* --- recency --- */
  let time_range: TimeRange | undefined;
  let time_sensitive = false;
  for (const rule of RECENCY) {
    if (!rule.test.test(raw)) continue;
    // first match is the tightest window (table is ordered tight → loose)
    if (!time_range) {
      time_range = rule.range;
      time_sensitive = true;
      signals.push(rule.signal);
    }
  }

  // News phrasing without an explicit window still deserves a fresh window.
  if (!time_range && (type === 'news' || scores.has('news'))) {
    time_range = 'week';
    time_sensitive = true;
    signals.push('recency_implied_by_news');
  }

  /* --- entities, keywords, filters --- */
  const entities = extractEntities(raw);
  const { include, exclude } = extractDomainFilters(raw);
  const country = extractCountry(raw);
  if (country) signals.push('country_detected');
  if (include.length) signals.push('include_domains_from_query');
  if (exclude.length) signals.push('exclude_domains_from_query');

  const filters: IntentFilters = {};
  if (type === 'news' || scores.has('news') || time_sensitive) filters.topic = 'news';
  if (time_range) filters.time_range = time_range;
  if (country) filters.country = country;
  if (include.length) filters.include_domains = include;
  if (exclude.length) filters.exclude_domains = exclude;

  const language = detectLanguage(raw);

  /* --- confidence --- */
  const hasStrongSignal = bestScore >= 3;
  const signalCount = signals.filter((s) => !s.startsWith('recency_')).length;
  const confidence = Math.min(
    0.95,
    0.3 + (hasStrongSignal ? 0.4 : 0.15) + Math.min(signalCount, 3) * 0.07,
  );

  const rewritten_query = rewriteQuery(raw, entities);

  return {
    type,
    confidence: Number(confidence.toFixed(2)),
    keywords: keywords(raw, 10),
    entities,
    time_sensitive,
    language,
    rewritten_query,
    filters,
    signals,
  };
}

/**
 * Merge caller-supplied parameters with what we inferred.
 * Explicit parameters always win — inference only fills the gaps.
 */
export function mergeIntentWithRequest(
  intent: Intent,
  req: {
    topic?: string;
    time_range?: string;
    country?: string;
    include_domains?: string[];
    exclude_domains?: string[];
  },
): IntentFilters {
  const merged: IntentFilters = { ...intent.filters };

  if (req.topic === 'general' || req.topic === 'news') merged.topic = req.topic;
  if (req.time_range) merged.time_range = req.time_range as TimeRange;
  if (req.country) merged.country = req.country;
  if (req.include_domains?.length) {
    merged.include_domains = [...new Set([...(merged.include_domains ?? []), ...req.include_domains])];
  }
  if (req.exclude_domains?.length) {
    merged.exclude_domains = [...new Set([...(merged.exclude_domains ?? []), ...req.exclude_domains])];
  }
  if (merged.topic !== 'news' && !req.time_range && !req.topic) {
    // caller asked for nothing fresh — don't impose a recency window
    if (!intent.time_sensitive) delete merged.time_range;
  }
  return merged;
}

export function isTimeRange(value: unknown): value is TimeRange {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year';
}
