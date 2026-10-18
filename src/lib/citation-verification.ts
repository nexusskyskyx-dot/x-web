import type { AnswerSource } from './answer.ts';

export interface CitationVerification {
  /** Supported means the citation was matched to evidence in its fetched source. */
  status: 'supported' | 'flagged' | 'not_checked';
  supported_claims: number;
  flagged_claims: number;
  method: 'source_text_overlap' | 'lexical_plus_semantic';
  semantic_checked_claims?: number;
  semantic_supported_claims?: number;
}

export interface CitationCheckResult {
  text: string;
  indices: number[];
  verification: CitationVerification;
}

export interface SemanticCitationCandidate {
  id: number;
  claim: string;
  citation_index: number;
  source_url: string;
  source_text: string;
}

export interface SemanticCitationReviewResult {
  checked_ids: number[];
  supported_ids: number[];
}

export type SemanticCitationReviewer = (candidates: SemanticCitationCandidate[]) => Promise<SemanticCitationReviewResult>;

const STOP_WORDS = new Set(
  `a an and are as at be been by can did do does for from had has have he her hers him his how i if in into is it its may might of on or our she that the their them then there these they this those through to was we were what when where which who why will with would you your el la los las un una unos unas de del al y o en por para con sin que es son fue ser como sobre entre`.split(/\s+/),
);

const EVIDENCE_TOKEN = /[\p{L}\p{N}]+/gu;

function claimTerms(claim: string): string[] {
  return [...new Set(
    (claim.toLocaleLowerCase().match(EVIDENCE_TOKEN) ?? [])
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  )];
}

/** A conservative lexical screen; snippets are not treated as fetched page evidence. */
function hasSourceEvidence(claim: string, source: AnswerSource | undefined): boolean {
  const pageText = source?.raw_content?.trim();
  if (!pageText) return false;
  const terms = claimTerms(claim.replace(/\[\d+\]/g, '').replace(/[*_`>#]/g, ' '));
  if (terms.length < 2) return false;

  const sourceTerms = new Set((pageText.toLocaleLowerCase().match(EVIDENCE_TOKEN) ?? []));
  const numericTerms = terms.filter((term) => /^\d+(?:[.,]\d+)?%?$/.test(term));
  if (numericTerms.some((term) => !sourceTerms.has(term.replace(/[.,]$/, '')))) return false;

  const matched = terms.filter((term) => sourceTerms.has(term)).length;
  const coverage = matched / terms.length;
  return matched >= (terms.length < 5 ? 2 : 3) && coverage >= 0.3;
}

interface ClaimSegment {
  prefix: string;
  claim: string;
  refs: number[];
  accepted: number[];
  semanticCandidates: SemanticCitationCandidate[];
}

interface ParsedText {
  lines: Array<{ segments: ClaimSegment[]; trailing: string }>;
  candidates: SemanticCitationCandidate[];
}

function parseText(text: string, sources: AnswerSource[]): ParsedText {
  let nextId = 1;
  const candidates: SemanticCitationCandidate[] = [];
  const lines = text.split('\n').map((line) => {
    const citationGroup = /([^\[]*?)((?:\s*\[\d+\])+)/g;
    const segments: ClaimSegment[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = citationGroup.exec(line)) !== null) {
      const claimPart = match[1];
      // A citation at a sentence end qualifies the immediately preceding sentence.
      const claim = claimPart.split(/(?<=[.!?])\s+/u).at(-1) ?? claimPart;
      const prefix = line.slice(cursor, match.index) + claimPart.slice(0, claimPart.length - claim.length);
      const refs = [...match[2].matchAll(/\[(\d+)\]/g)].map((item) => Number(item[1]));
      const accepted = refs.filter((index) => hasSourceEvidence(claim, sources[index - 1]));
      const semanticCandidates = refs
        .filter((index) => !accepted.includes(index))
        .map((index) => ({ source: sources[index - 1], index }))
        .filter(({ source }) => Boolean(source?.raw_content?.trim()))
        .map(({ source, index }) => ({
          id: nextId++,
          claim: claim.trim(),
          citation_index: index,
          source_url: source!.url,
          source_text: source!.raw_content!.trim(),
        }));
      candidates.push(...semanticCandidates);
      segments.push({ prefix, claim, refs, accepted, semanticCandidates });
      cursor = match.index + match[0].length;
    }
    return { segments, trailing: line.slice(cursor) };
  });
  return { lines, candidates };
}

function renderCheckedText(
  parsed: ParsedText,
  semanticSupportedIds: Set<number>,
  semanticCheckedIds: Set<number>,
): CitationCheckResult {
  let supportedClaims = 0;
  let flaggedClaims = 0;
  let semanticSupportedClaims = 0;
  const keptIndices = new Set<number>();
  const lines = parsed.lines.map(({ segments, trailing }) => {
    const line = segments.map((segment) => {
      const semanticAccepted = segment.semanticCandidates
        .filter((candidate) => semanticSupportedIds.has(candidate.id))
        .map((candidate) => candidate.citation_index);
      const accepted = [...new Set([...segment.accepted, ...semanticAccepted])];
      if (accepted.length) {
        supportedClaims += 1;
        if (semanticAccepted.length) semanticSupportedClaims += 1;
        accepted.forEach((index) => keptIndices.add(index));
        return `${segment.prefix}${segment.claim} ${accepted.map((index) => `[${index}]`).join(' ')}`;
      }
      flaggedClaims += 1;
      return `${segment.prefix}${segment.claim} [Unverified]`;
    }).join('');
    return line + trailing;
  }).join('\n');

  const semanticCheckedClaims = parsed.lines.reduce((count, line) => count + line.segments.filter((segment) =>
    segment.semanticCandidates.some((candidate) => semanticCheckedIds.has(candidate.id)),
  ).length, 0);
  const method: CitationVerification['method'] = semanticCheckedClaims > 0
    ? 'lexical_plus_semantic'
    : 'source_text_overlap';
  const status: CitationVerification['status'] = flaggedClaims
    ? 'flagged'
    : supportedClaims
      ? 'supported'
      : 'not_checked';
  return {
    text: lines,
    indices: [...keptIndices].sort((a, b) => a - b),
    verification: {
      status,
      supported_claims: supportedClaims,
      flagged_claims: flaggedClaims,
      method,
      ...(semanticCheckedClaims ? { semantic_checked_claims: semanticCheckedClaims } : {}),
      ...(semanticSupportedClaims ? { semantic_supported_claims: semanticSupportedClaims } : {}),
    },
  };
}

/** Deterministically checks inline citations against their corresponding fetched page text. */
export function verifyCitedClaims(text: string, sources: AnswerSource[]): CitationCheckResult {
  return renderCheckedText(parseText(text, sources), new Set(), new Set());
}

/**
 * Optional BYOK-backed second pass for claims that fail lexical matching.
 * The reviewer is called once with a batch; it must return IDs only when the
 * claim is entailed and backed by a quote that it has verified against source_text.
 */
export async function verifyCitedClaimsWithSemantic(
  text: string,
  sources: AnswerSource[],
  reviewer: SemanticCitationReviewer,
): Promise<CitationCheckResult> {
  const parsed = parseText(text, sources);
  let semanticSupportedIds = new Set<number>();
  let semanticCheckedIds = new Set<number>();
  if (parsed.candidates.length) {
    try {
      const review = await reviewer(parsed.candidates);
      semanticSupportedIds = new Set(review.supported_ids);
      semanticCheckedIds = new Set(review.checked_ids);
    } catch {
      // Fail closed: a timeout or malformed verifier reply cannot promote a citation.
    }
  }
  return renderCheckedText(parsed, semanticSupportedIds, semanticCheckedIds);
}
