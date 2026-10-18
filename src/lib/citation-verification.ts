import type { AnswerSource } from './answer.ts';

export interface CitationVerification {
  /** Supported means the cited source contains a measurable lexical evidence match. */
  status: 'supported' | 'flagged' | 'not_checked';
  supported_claims: number;
  flagged_claims: number;
  method: 'source_text_overlap';
}

export interface CitationCheckResult {
  text: string;
  indices: number[];
  verification: CitationVerification;
}

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

/**
 * A conservative lexical evidence screen, not a semantic entailment proof.
 * Raw page text is preferred; snippets are not treated as scraped evidence.
 */
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
  const minimumMatches = terms.length < 5 ? 2 : 3;
  return matched >= minimumMatches && coverage >= 0.3;
}

/**
 * Validates each inline [n] reference against the corresponding fetched page.
 * Unsupported markers are removed and their claim is visibly flagged.
 */
export function verifyCitedClaims(text: string, sources: AnswerSource[]): CitationCheckResult {
  let supportedClaims = 0;
  let flaggedClaims = 0;
  const keptIndices = new Set<number>();
  const lines = text.split('\n');
  const checkedLines = lines.map((line) => {
    // Each match is a claim fragment followed by one or more inline references.
    const citationGroup = /([^\[]*?)((?:\s*\[\d+\])+)/g;
    let output = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = citationGroup.exec(line)) !== null) {
      // A citation at the end of a line normally qualifies the immediately
      // preceding sentence, not every earlier sentence on that same line.
      const claimPart = match[1];
      const claim = claimPart.split(/(?<=[.!?])\s+/u).at(-1) ?? claimPart;
      const prefix = claimPart.slice(0, claimPart.length - claim.length);
      const markerGroup = match[2];
      const refs = [...markerGroup.matchAll(/\[(\d+)\]/g)].map((item) => Number(item[1]));
      const accepted = refs.filter((index) => hasSourceEvidence(claim, sources[index - 1]));
      output += line.slice(cursor, match.index) + prefix + claim;
      if (accepted.length) {
        supportedClaims += 1;
        accepted.forEach((index) => keptIndices.add(index));
        output += ` ${[...new Set(accepted)].map((index) => `[${index}]`).join(' ')}`;
      } else {
        flaggedClaims += 1;
        output += ' [Unverified]';
      }
      cursor = match.index + match[0].length;
    }
    return output + line.slice(cursor);
  });

  const status: CitationVerification['status'] = flaggedClaims
    ? 'flagged'
    : supportedClaims
      ? 'supported'
      : 'not_checked';
  return {
    text: checkedLines.join('\n'),
    indices: [...keptIndices].sort((a, b) => a - b),
    verification: {
      status,
      supported_claims: supportedClaims,
      flagged_claims: flaggedClaims,
      method: 'source_text_overlap',
    },
  };
}
