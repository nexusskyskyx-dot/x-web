/**
 * Shared text primitives.
 *
 * Everything here is deliberately dependency-free and pure so the intent
 * classifier, the answer synthesiser and the extractor all agree on what a
 * "word" or a "sentence" is — and so all of it is unit-testable without a
 * network call.
 */

/** Lowercase word tokens, diacritics folded so "café" matches "cafe". */
export function tokenize(input: string): string[] {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#._-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Split into sentences. Keeps the trailing punctuation so reassembled text
 * reads naturally, and is careful about the cases that break naive splitters:
 * abbreviations, decimals, ellipses and citation markers like `[3]`.
 */
export function splitSentences(input: string): string[] {
  const text = (input ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const parts = text
    .replace(/([.!?])([\])"'])\s+(?=[A-Z0-9])/g, '$1$2\u0000')
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Inc|Ltd|No|fig|approx)\.\s+/gi, '$1\u0004 ')
    .replace(/(\d)\.(\d)/g, '$1\u0002$2')
    .replace(/([.!?])\s+(?=[A-Z"'([0-9])/g, '$1\u0000')
    .replace(/\.\.\.\s*/g, '\u0003')
    .split(/\u0000+/)
    .map((s) => s.replace(/\u0002/g, '.').replace(/\u0003/g, '…').replace(/\u0004/g, '.').trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [text];
}

/** Trim to a whole sentence where possible, so we never cut mid-thought. */
export function truncateSentences(input: string, maxChars: number): string {
  const text = (input ?? '').trim();
  if (text.length <= maxChars) return text;
  let out = '';
  for (const sentence of splitSentences(text)) {
    if (out && (out + ' ' + sentence).length > maxChars) break;
    out = out ? `${out} ${sentence}` : sentence;
    if (out.length >= maxChars) break;
  }
  if (out) return out;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

export function truncateChars(input: string, maxChars: number): string {
  const text = (input ?? '').trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.75 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Content words: tokens with stopwords removed. Used for keyword extraction
 * and for scoring how well a sentence answers a query.
 */
const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being
   below between both but by can cannot could couldn't did didn't do does doesn't doing don't down
   during each few for from further had hadn't has hasn't have haven't having he her here hers
   herself him himself his how i i'm if in into is isn't it it's its itself just let's me more most
   mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own
   same shan't she should shouldn't so some such than that that's the their theirs them themselves
   then there there's these they they're this those through to too under until up very was wasn't
   we we're were weren't what what's when where which while who whom why with won't would wouldn't
   you you'd you'll you're you've your yours yourself yourselves
   am are is was were be being been
   can could may might must shall should will would
   please tell show give find get make use using want need like know think say said
   also however moreover furthermore therefore thus hence
   one two three many much several various
   yes okay ok well now really quite very much lot lots
   el la los las de que y en un una por para con es son como del al se su mas pero
   le les des et est pour dans qui sur avec une du au aux ce pas comment pourquoi sont
   der die das und ist sind fur mit auf einen den dem des nicht wie warum von zu im auch oder
   il che per con sono cosa del della nel piu questo questa
   do da em um uma com para e nao voce sao no na os as se mais como que
   het van voor niet zijn aan er om te wat waarom worden
   och att det som till ar ett av pa inte hur vad varfor den
   http https www com org net html`
    .split(/\s+/)
    .filter(Boolean),
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

/** Lowercased content tokens, stopwords dropped, deduplicated in order. */
export function keywords(input: string, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(input)) {
    if (token.length < 2) continue;
    if (isStopword(token)) continue;
    if (/^\d+$/.test(token) && token.length < 4) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Fraction of the query's content terms present in `text`.
 * Returns 0..1. This is the backbone of both the extractive answer score and
 * the relevance guard that stops us asserting an answer from unrelated text.
 */
export function termCoverage(query: string, text: string): number {
  const qTerms = new Set(keywords(query, 20));
  if (qTerms.size === 0) return 0;
  const haystack = new Set(tokenize(text));
  let hits = 0;
  for (const term of qTerms) {
    if (haystack.has(term)) hits += 1;
    else if ([...haystack].some((w) => w.startsWith(term) && term.length >= 4)) hits += 0.5;
  }
  return Math.min(hits / qTerms.size, 1);
}

/** Cheap near-duplicate check — results and sentences both need it. */
export function normalizeForDedupe(input: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isNearDuplicate(a: string, b: string): boolean {
  const x = normalizeForDedupe(a);
  const y = normalizeForDedupe(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 40 && longer.includes(shorter);
}

/** Collapse whitespace and decode the entities that survive HTML parsing. */
export function cleanText(input: string): string {
  return (input ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
        return '\uFFFD';
      }
      return String.fromCodePoint(point);
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
