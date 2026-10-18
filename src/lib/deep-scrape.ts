import { assertPublicUrl, type ExtractedPage } from './extract.ts';

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';
const EXPANSION_ACTIONS = [
  { type: 'wait', milliseconds: 700 },
  { type: 'click', selector: 'button[aria-expanded="false"], [role="button"][aria-expanded="false"], details:not([open]) > summary' },
  { type: 'click', selector: 'text=Read more' },
  { type: 'click', selector: 'text=Show more' },
  { type: 'click', selector: 'text=Show all' },
  { type: 'scroll', direction: 'down' },
  { type: 'wait', milliseconds: 900 },
];

interface FirecrawlData {
  markdown?: string;
  metadata?: Record<string, unknown>;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function scrapeOne(url: string, apiKey: string, maxChars: number): Promise<ExtractedPage> {
  try {
    const parsed = new URL(url);
    await assertPublicUrl(parsed);
    const response = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: parsed.href,
        formats: ['markdown'],
        onlyMainContent: true,
        actions: EXPANSION_ACTIONS,
        timeout: 45_000,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: FirecrawlData; error?: string; success?: boolean };
    if (!response.ok || payload.success === false) {
      return { url, error: `Deep scrape failed${response.status ? ` (HTTP ${response.status})` : ''}: ${cleanText(payload.error) ?? 'Firecrawl could not process this page.'}` };
    }
    const data = payload.data ?? payload as unknown as FirecrawlData;
    const text = cleanText(data.markdown)?.slice(0, maxChars);
    if (!text) return { url, error: 'Deep scrape returned no readable page text.' };
    const metadata = data.metadata ?? {};
    return {
      url,
      title: cleanText(metadata.title),
      text,
      word_count: wordCount(text),
      language: cleanText(metadata.language),
      published_date: cleanText(metadata.publishedTime ?? metadata.published_date),
      site_name: cleanText(metadata.ogSiteName ?? metadata.siteName),
      description: cleanText(metadata.description),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, error: /abort|timeout/i.test(message) ? 'Deep scrape timed out.' : `Deep scrape failed: ${message}` };
  }
}

/**
 * Uses the caller's Firecrawl BYOK key to render, expand common disclosure
 * controls, scroll for lazy content, and extract the top few public pages.
 * Interactions are best-effort: sites can still hide content behind custom UI,
 * authentication, anti-bot checks, or inaccessible client-side code.
 */
export async function deepScrapePages(
  urls: string[],
  apiKey: string,
  options: { maxChars?: number; concurrency?: number } = {},
): Promise<ExtractedPage[]> {
  const maxChars = Math.max(500, Math.min(options.maxChars ?? 30_000, 100_000));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 3));
  const results: ExtractedPage[] = new Array(urls.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (cursor < urls.length) {
      const index = cursor++;
      results[index] = await scrapeOne(urls[index], apiKey, maxChars);
    }
  }));
  return results;
}
