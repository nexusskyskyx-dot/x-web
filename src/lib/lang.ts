/**
 * Language detection for multi-language search.
 *
 * Deliberately self-contained: no model download, no network, no per-request
 * cost. Two stages:
 *
 *   1. Script detection — an unambiguous signal. Japanese kana, Korean hangul,
 *      Greek, Cyrillic, Arabic, Hebrew, Devanagari, Thai, and CJK ideographs
 *      each pin the language (or narrow it to two or three candidates).
 *   2. Function-word scoring for everything written in Latin/Cyrillic script.
 *      Stopwords are far more reliable than letter frequencies on short
 *      queries, which is all we ever get.
 *
 * Returns BCP-47 tags (ISO-639-1, plus region where the script implies one).
 */

export interface LanguageGuess {
  /** BCP-47 tag, e.g. "en", "pt-BR", "zh-CN". "und" when undetermined. */
  code: string;
  /** ISO-639-1 language subtag only. */
  language: string;
  /** 0..1 — how sure we are. */
  confidence: number;
  /** Human-readable name. */
  name: string;
}

export const UNKNOWN: LanguageGuess = {
  code: 'und',
  language: 'und',
  confidence: 0,
  name: 'Unknown',
};

/** Script ranges that identify a language outright. */
const SCRIPTS: Array<{
  name: string;
  code: string;
  test: RegExp;
  language: string;
}> = [
  { name: 'Japanese', code: 'ja', language: 'ja', test: /[぀-ヿ]/ },
  { name: 'Korean', code: 'ko', language: 'ko', test: /[가-힯]/ },
  { name: 'Greek', code: 'el', language: 'el', test: /[Ͱ-Ͽ]/ },
  { name: 'Thai', code: 'th', language: 'th', test: /[฀-๿]/ },
  { name: 'Devanagari', code: 'hi', language: 'hi', test: /[ऀ-ॿ]/ },
  { name: 'Hebrew', code: 'he', language: 'he', test: /[֐-׿]/ },
  { name: 'Arabic', code: 'ar', language: 'ar', test: /[؀-ۿ]/ },
  { name: 'Chinese (Simplified)', code: 'zh-CN', language: 'zh', test: /[一-鿿]/ },
  { name: 'Russian', code: 'ru', language: 'ru', test: /[Ѐ-ӿ]/ },
];

/**
 * Function words per language. These are the highest-frequency,
 * least-ambiguous words — articles, pronouns, prepositions and copulas that
 * almost never appear as content and almost always appear in running text.
 */
const MARKERS: Record<string, { name: string; words: string[] }> = {
  en: { name: 'English', words: ['the', 'and', 'is', 'are', 'of', 'to', 'in', 'for', 'with', 'on', 'that', 'this', 'what', 'how', 'why', 'when', 'which', 'does', 'do', 'can', 'you', 'your', 'from', 'it', 'was', 'were', 'have', 'has', 'will', 'about'] },
  es: { name: 'Spanish', words: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'para', 'con', 'es', 'son', 'como', 'qué', 'cómo', 'por', 'del', 'al', 'se', 'su', 'más', 'pero'] },
  fr: { name: 'French', words: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'pour', 'dans', 'que', 'qui', 'sur', 'avec', 'une', 'un', 'du', 'au', 'aux', 'ce', 'pas', 'comment', 'pourquoi', 'sont', 'sont'] },
  de: { name: 'German', words: ['der', 'die', 'das', 'und', 'ist', 'sind', 'für', 'mit', 'auf', 'eine', 'einen', 'den', 'dem', 'des', 'nicht', 'wie', 'was', 'warum', 'von', 'zu', 'im', 'auch', 'oder', 'kann'] },
  it: { name: 'Italian', words: ['il', 'la', 'di', 'che', 'e', 'per', 'con', 'una', 'un', 'su', 'sono', 'come', 'cosa', 'perché', 'del', 'della', 'nel', 'più', 'essere', 'questo', 'questa'] },
  pt: { name: 'Portuguese', words: ['de', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'com', 'para', 'é', 'são', 'como', 'por', 'mais', 'no', 'na', 'os', 'as', 'se', 'por', 'qual', 'quando'] },
  nl: { name: 'Dutch', words: ['de', 'het', 'een', 'van', 'en', 'is', 'voor', 'met', 'op', 'dat', 'die', 'niet', 'zijn', 'aan', 'er', 'om', 'te', 'hoe', 'wat', 'waarom', 'worden'] },
  sv: { name: 'Swedish', words: ['och', 'att', 'det', 'som', 'för', 'med', 'till', 'är', 'en', 'ett', 'av', 'på', 'inte', 'hur', 'vad', 'varför', 'den', 'de', 'om'] },
  pl: { name: 'Polish', words: ['jest', 'nie', 'to', 'na', 'do', 'że', 'się', 'oraz', 'jak', 'co', 'dlaczego', 'dla', 'z', 'w', 'po', 'od', 'są', 'być', 'ten', 'tego'] },
  tr: { name: 'Turkish', words: ['bir', 've', 'bu', 'için', 'ile', 'olarak', 'ne', 'nasıl', 'neden', 'var', 'yok', 'daha', 'en', 'de', 'da', 'olan', 'gibi', 'ancak'] },
  ru: { name: 'Russian', words: ['это', 'не', 'для', 'как', 'что', 'почему', 'когда', 'который', 'быть', 'есть', 'или', 'но', 'все', 'так', 'его', 'она', 'они', 'мы'] },
  id: { name: 'Indonesian', words: ['yang', 'dan', 'untuk', 'dengan', 'adalah', 'dari', 'ini', 'itu', 'tidak', 'apa', 'bagaimana', 'mengapa', 'pada', 'dalam', 'akan', 'dapat'] },
};

const TRADITIONAL_ONLY = new Set(
  '個們來時對說過還會國學電機開發產經體臺灣網際網路'.split(''),
);

function fold(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function words(input: string): string[] {
  return fold(input)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function detectLanguage(input: string): LanguageGuess {
  const text = (input ?? '').trim();
  if (!text) return UNKNOWN;

  // --- stage 1: script ---
  for (const script of SCRIPTS) {
    if (!script.test.test(text)) continue;
    // CJK is shared by Simplified/Traditional — distinguish by character forms.
    if (script.language === 'zh') {
      const hasTraditional = [...text].some((ch) => TRADITIONAL_ONLY.has(ch));
      return {
        code: hasTraditional ? 'zh-TW' : 'zh-CN',
        language: 'zh',
        confidence: 0.92,
        name: hasTraditional ? 'Chinese (Traditional)' : 'Chinese (Simplified)',
      };
    }
    return { code: script.code, language: script.language, confidence: 0.9, name: script.name };
  }

  // --- stage 2: function words ---
  const tokens = words(text);
  if (tokens.length === 0) return UNKNOWN;

  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  let best: { code: string; name: string; score: number } | null = null;
  let second = 0;

  for (const [code, marker] of Object.entries(MARKERS)) {
    let score = 0;
    for (const word of marker.words) {
      const hits = counts.get(word) ?? 0;
      // more, rarer marker words beat one repeated "the"
      score += Math.min(hits, 2);
    }
    // Normalise by query length so a 2-word query isn't drowned out.
    const normalised = score / Math.max(tokens.length, 4);
    if (!best || normalised > best.score) {
      second = best?.score ?? 0;
      best = { code, name: marker.name, score: normalised };
    } else if (normalised > second) {
      second = normalised;
    }
  }

  if (!best || best.score <= 0) return UNKNOWN;

  // Portuguese vs Spanish overlap heavily — break the tie on distinctive words.
  let code = best.code;
  if (code === 'pt' || code === 'es') {
    const es = /[¿¡]|ción|ñ|más|está/.test(fold(text));
    const pt = /ção|ã|õ|não|você|é /
      .test(fold(text));
    if (es && !pt) code = 'es';
    else if (pt && !es) code = 'pt';
  }

  const margin = best.score - second;
  const confidence = Math.max(0.15, Math.min(0.95, 0.35 + best.score * 0.9 + margin * 0.5));

  return {
    code,
    language: code,
    confidence: Number(confidence.toFixed(2)),
    name: MARKERS[code]?.name ?? code,
  };
}

/** Resolve a caller/auto language request into a concrete language code. */
export function resolveLanguage(
  requested: string | undefined,
  query: string,
): { language: string; detected: LanguageGuess; auto: boolean } {
  const detected = detectLanguage(query);
  const raw = (requested ?? '').trim().toLowerCase();

  if (!raw || raw === 'auto' || raw === 'detect') {
    return {
      language: detected.language === 'und' ? 'en' : detected.language,
      detected,
      auto: true,
    };
  }

  // Accept "pt-BR", "pt_BR", "zh-Hans-CN" — take the primary subtag.
  const primary = raw.split(/[-_]/)[0];
  return {
    language: primary || detected.language,
    detected,
    auto: false,
  };
}

/** Languages we can pass through to at least one provider. */
export const SUPPORTED_LANGUAGES = [
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'id', 'it', 'ja',
  'ko', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'zh',
] as const;
