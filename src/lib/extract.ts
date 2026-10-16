/**
 * Page extraction: URL → clean readable text.
 *
 * Search gives you a snippet; agents usually need the actual content. This
 * fetches a URL server-side, strips the chrome (nav, ads, cookie banners,
 * footers), and returns the main text.
 *
 * The block-scoring heuristic is a compact readability pass: score every
 * container by text density and link density, prefer semantic landmarks
 * (`<article>`, `<main>`, `[role=main]`), then fall back to the densest
 * block. It is deliberately dependency-light — one small HTML parser, no
 * browser, so it runs inside a serverless function budget.
 *
 * Nothing here throws at the caller: a page that cannot be fetched or parsed
 * comes back as a result with an `error` field, so one bad URL in a batch of
 * ten does not lose the other nine.
 */

import { parse } from 'node-html-parser';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { cleanText, truncateChars } from './text.ts';
import { detectLanguage } from './lang.ts';

export interface ExtractOptions {
  /** Hard cap per page, applied at a sentence boundary where possible. */
  maxChars?: number;
  /** Wall-clock budget per page. */
  timeoutMs?: number;
  /** Reject responses larger than this before parsing. */
  maxBytes?: number;
}

export interface ExtractedPage {
  url: string;
  title?: string;
  text?: string;
  word_count?: number;
  language?: string;
  published_date?: string;
  site_name?: string;
  description?: string;
  /** Set instead of the fields above when the page could not be processed. */
  error?: string;
}

const DEFAULTS: Required<ExtractOptions> = {
  maxChars: 12_000,
  timeoutMs: 15_000,
  maxBytes: 3_000_000,
};

const UA =
  'Mozilla/5.0 (compatible; x-web/1.0; +https://github.com/nexusskyskyx-dot/x-web)';

/** SSRF guard: reject loopback, private, link-local, multicast and reserved IPs. */
function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().split('%')[0];
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    // Block mapped/transition forms rather than risk an embedded private IPv4.
    if (ip.startsWith('::ffff:') || ip.startsWith('2002:') || ip.startsWith('2001:0:')) return false;
    // Only globally-routable unicast is eligible. This rejects unspecified,
    // loopback, unique-local, link-local, multicast and reserved ranges.
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    if (first < 0x2000 || first > 0x3fff) return false;
    if (ip.startsWith('2001:db8:')) return false;
    return true;
  }
  return false;
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${url.protocol}".`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private or local network URLs cannot be extracted.');
  }
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Private or reserved IP addresses cannot be extracted.');
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('The hostname resolves to a private or reserved network address.');
  }
}

/** Containers that never hold article content. */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'form', 'input', 'select', 'textarea', 'button', 'nav', 'header', 'footer',
  'aside', 'template', 'dialog', 'picture', 'source', 'video', 'audio', 'map',
]);

/** Signposted boilerplate that survives tag stripping. */
const BOILERPLATE_HINTS =
  /\b(cookie|newsletter|subscribe|sign\s?up|log\s?in|paywall|advertis|sponsored|related\s+articles?|read\s+more\s+about|all\s+rights\s+reserved)\b/i;

function metaContent(root: ReturnType<typeof parse>, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    const value = node?.getAttribute('content') ?? node?.getAttribute('property') ?? node?.text;
    if (value && value.trim()) return cleanText(value).slice(0, 400);
  }
  return undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return undefined;
  return parsed.toISOString();
}

/**
 * Score a container as the main content block.
 * Text-heavy, link-light, deep in paragraphs, and semantically marked-up wins.
 */
function scoreBlock(el: {
  tagName?: string;
  getAttribute: (name: string) => string | undefined;
  text: string;
  querySelectorAll: (selector: string) => Array<{ text: string }>;
}): number {
  const text = el.text ?? '';
  const chars = text.replace(/\s+/g, ' ').trim().length;
  if (chars < 140) return 0;

  const paragraphs = el.querySelectorAll('p');
  const paragraphChars = paragraphs.reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
  const links = el.querySelectorAll('a');
  const linkChars = links.reduce((sum, a) => sum + (a.text?.length ?? 0), 0);

  const linkDensity = chars > 0 ? linkChars / chars : 1;
  const paragraphRatio = chars > 0 ? paragraphChars / chars : 0;

  let score = chars / 100;
  score += paragraphRatio * 8;
  score += Math.min(paragraphs.length, 25) * 0.8;
  score -= linkDensity * 25;

  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'article' || tag === 'main') score += 12;
  const role = el.getAttribute?.('role');
  if (role === 'main' || role === 'article') score += 12;

  const cls = `${el.getAttribute?.('class') ?? ''} ${el.getAttribute?.('id') ?? ''}`.toLowerCase();
  if (/\b(article|post|content|entry|story|body|main)\b/.test(cls)) score += 6;
  if (/\b(comment|sidebar|widget|related|promo|ad|advert|footer|header|nav|menu)\b/.test(cls)) {
    score -= 14;
  }
  if (BOILERPLATE_HINTS.test(text.slice(0, 400))) score -= 8;

  return score;
}

/** Strip chrome in place so the text we read is the text a human would read. */
function stripChrome(root: ReturnType<typeof parse>): void {
  for (const tag of DROP_TAGS) {
    for (const node of root.querySelectorAll(tag)) node.remove();
  }
  // Comment threads and "you may also like" rails, by DOM convention.
  for (const node of root.querySelectorAll('[class*="comment"], [id*="comment"], [class*="sidebar"], [class*="related"], [class*="newsletter"], [class*="cookie"], [aria-hidden="true"]')) {
    node.remove();
  }
}

export function extractFromHtml(html: string, url: string, options: ExtractOptions = {}): ExtractedPage {
  const opts = { ...DEFAULTS, ...options };
  const out: ExtractedPage = { url };

  let root: ReturnType<typeof parse>;
  try {
    root = parse(html);
  } catch {
    out.error = 'Could not parse the page HTML.';
    return out;
  }

  out.title =
    metaContent(root, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    cleanText(root.querySelector('title')?.text ?? '') ||
    cleanText(root.querySelector('h1')?.text ?? '') ||
    undefined;

  out.description = metaContent(root, ['meta[name="description"]', 'meta[property="og:description"]']);
  out.site_name = metaContent(root, ['meta[property="og:site_name"]']);
  out.published_date = normalizeDate(
    metaContent(root, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[itemprop="datePublished"]',
      'time[datetime]',
    ]) ?? root.querySelector('time')?.getAttribute?.('datetime'),
  );

  stripChrome(root);

  // Prefer the explicit landmarks; only if they are missing or thin do we
  // fall back to scoring every div/section.
  const candidates: Array<{ el: any; score: number }> = [];
  for (const el of root.querySelectorAll('article, main, [role="main"], [role="article"]')) {
    const score = scoreBlock(el as any);
    if (score > 0) candidates.push({ el, score });
  }
  if (candidates.length === 0) {
    for (const el of root.querySelectorAll('div, section')) {
      const score = scoreBlock(el as any);
      if (score > 0) candidates.push({ el, score });
    }
  }

  let text: string;
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].el;
    text = cleanText(
      best
        .querySelectorAll('p, h1, h2, h3, h4, li, blockquote, pre, td')
        .map((n: any) => n.text)
        .join('\n\n') || best.text,
    );
  } else {
    text = cleanText(root.querySelector('body')?.text ?? root.text ?? '');
  }

  if (!text || text.length < 40) {
    out.error = 'No readable content found on this page.';
    return out;
  }

  out.text = truncateChars(text, opts.maxChars);
  out.word_count = out.text.split(/\s+/).filter(Boolean).length;
  out.language = detectLanguage(out.text).language;
  if (out.language === 'und') delete out.language;

  return out;
}

/** Fetch and extract one page. Never throws. */
export async function extractPage(
  url: string,
  options: ExtractOptions = {},
): Promise<ExtractedPage> {
  const opts = { ...DEFAULTS, ...options };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, error: 'Not a valid absolute URL.' };
  }
  try {
    // Validate every redirect hop ourselves. Following redirects automatically
    // would let a public page redirect the extractor into localhost or a cloud
    // metadata endpoint (SSRF).
    let current = parsed;
    let response: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      await assertPublicUrl(current);
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return { url, error: 'Redirect response did not include a location.' };
        if (hop === 5) return { url, error: 'Too many redirects while fetching the page.' };
        current = new URL(location, current);
        continue;
      }
      break;
    }

    if (!response) return { url, error: 'Could not fetch the page.' };
    if (!response.ok) return { url, error: `Upstream returned HTTP ${response.status}.` };

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return { url, error: `Unsupported content type "${contentType}".` };
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > opts.maxBytes) {
      return { url, error: `Page is too large (${declared} bytes).` };
    }

    const html = await response.text();
    if (html.length > opts.maxBytes) {
      return { url, error: `Page is too large (${html.length} bytes).` };
    }

    return extractFromHtml(html, url, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message)) return { url, error: 'Timed out fetching the page.' };
    return { url, error: `Could not fetch the page: ${message}` };
  }
}

/** Extract several pages with a concurrency cap. Never throws. */
export async function extractPages(
  urls: string[],
  options: ExtractOptions & { concurrency?: number } = {},
): Promise<ExtractedPage[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const queue = [...urls];
  const results: ExtractedPage[] = new Array(urls.length);

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const index = urls.length - queue.length;
      const url = queue.shift();
      if (url === undefined) break;
      results[index] = await extractPage(url, options);
    }
  });

  await Promise.all(workers);
  return results;
}
