/**
 * Deterministic best-results ranking and cross-source deduplication.
 *
 * Authority here is an explicit, inspectable domain heuristic — strong signals
 * for government, education, international bodies and known official docs, not
 * a claim of a universal or personalized reputation model. Confidence scores
 * and personalized ranking are intentionally left for a later phase.
 */

import { termCoverage, normalizeForDedupe } from './text.ts';
import type { ProviderId, SearchHit } from './search.ts';

export interface RankedHit extends SearchHit {
  /** Sources that independently returned this result. */
  providers: ProviderId[];
  source_count: number;
  /** 0..1 weighted ordering score. This is not a probability/confidence. */
  ranking_score: number;
  rank_signals: {
    relevance: number;
    freshness: number;
    authority: number;
    corroboration: number;
  };
}

export interface ProviderHits {
  provider: ProviderId;
  results: SearchHit[];
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|yclid|ref_src|ref_url)$/i;
const KNOWN_OFFICIAL = new Set([
  'developer.mozilla.org', 'docs.github.com', 'w3.org',
  'who.int', 'un.org', 'europa.eu', 'nasa.gov', 'nih.gov', 'ncbi.nlm.nih.gov',
  'cloud.google.com', 'learn.microsoft.com', 'docs.aws.amazon.com',
  'docs.astro.build', 'nodejs.org', 'typescriptlang.org',
]);

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = url.protocol.toLowerCase();
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.trim().toLowerCase();
  }
}

function domainOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

/** Public, rule-based domain authority signal: 0..1. */
export function authoritySignal(rawUrl: string): number {
  const host = domainOf(rawUrl);
  if (!host) return 0.5;
  if ([...KNOWN_OFFICIAL].some((domain) => host === domain || host.endsWith(`.${domain}`))) return 1;
  if (/\.gov(?:\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) return 0.98;
  if (/\.edu(?:\.[a-z]{2})?$/.test(host) || /\.edu\.[a-z]{2}$/.test(host)) return 0.95;
  if (/\.int$/.test(host)) return 0.96;
  if (/\.org$/.test(host)) return 0.72;
  if (/\.(?:com|net|io|dev|co|ai|info|biz)$/.test(host)) return 0.6;
  return 0.55;
}

function freshnessSignal(date: string | undefined, now: number): number {
  if (!date) return 0.35;
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return 0.35;
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return Math.max(0.05, Math.exp(-ageDays / 180));
}

function providerRelevance(hit: SearchHit, providerRank: number, query: string): number {
  const rankScore = 1 / Math.sqrt(Math.max(providerRank, 1));
  const contentScore = termCoverage(query, `${hit.title ?? ''} ${hit.snippet ?? ''}`);
  const upstream = typeof hit.score === 'number' ? Math.max(0, Math.min(hit.score, 1)) : rankScore;
  return Math.max(0, Math.min(1, upstream * 0.45 + rankScore * 0.2 + contentScore * 0.35));
}

interface Candidate {
  hit: SearchHit;
  provider: ProviderId;
  providerRank: number;
  relevance: number;
  freshness: number;
  authority: number;
  canonical: string;
  titleKey: string;
}

function isSameResult(a: Candidate, b: Candidate): boolean {
  if (a.canonical && b.canonical && a.canonical === b.canonical) return true;
  // Search providers sometimes expose tracking/proxy URLs for the same page.
  // Identical normalized title + publisher domain is a conservative fallback.
  return Boolean(
    a.titleKey.length >= 16 &&
    a.titleKey === b.titleKey &&
    domainOf(a.hit.url) &&
    domainOf(a.hit.url) === domainOf(b.hit.url),
  );
}

/** Blend, dedupe and rerank provider result lists into a single top-N set. */
export function rankAndBlend(
  query: string,
  lists: ProviderHits[],
  options: { maxResults?: number; now?: number } = {},
): RankedHit[] {
  const now = options.now ?? Date.now();
  const maxResults = Math.max(1, Math.min(Math.trunc(options.maxResults ?? 10), 50));
  const candidates: Candidate[] = [];

  for (const list of lists) {
    list.results.forEach((hit, index) => {
      if (!hit.url || !/^https?:\/\//i.test(hit.url)) return;
      candidates.push({
        hit,
        provider: list.provider,
        providerRank: index + 1,
        relevance: providerRelevance(hit, index + 1, query),
        freshness: freshnessSignal(hit.published_date, now),
        authority: authoritySignal(hit.url),
        canonical: canonicalUrl(hit.url),
        titleKey: normalizeForDedupe(hit.title).replace(/\s+/g, ' ').trim(),
      });
    });
  }

  let groups: Candidate[][] = [];
  for (const candidate of candidates) {
    const i = groups.findIndex((group) => group.some((existing) => isSameResult(existing, candidate)));
    if (i === -1) groups.push([candidate]);
    else groups[i].push(candidate);
  }

  const ranked: RankedHit[] = groups.map((group) => {
    const best = [...group].sort((a, b) => b.relevance - a.relevance)[0];
    const providers = [...new Set(group.map((item) => item.provider))];
    const relevance = Math.max(...group.map((item) => item.relevance));
    const freshness = Math.max(...group.map((item) => item.freshness));
    const authority = Math.max(...group.map((item) => item.authority));
    const corroboration = Math.min(1, 0.35 + (providers.length - 1) * 0.4);
    const rankingScore = relevance * 0.62 + freshness * 0.22 + authority * 0.13 + corroboration * 0.03;

    return {
      ...best.hit,
      providers,
      source_count: providers.length,
      ranking_score: Number(rankingScore.toFixed(4)),
      rank_signals: {
        relevance: Number(relevance.toFixed(3)),
        freshness: Number(freshness.toFixed(3)),
        authority: Number(authority.toFixed(3)),
        corroboration: Number(corroboration.toFixed(3)),
      },
    };
  });

  return ranked.sort((a, b) => b.ranking_score - a.ranking_score).slice(0, maxResults);
}
