import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, extractPage } from './extract.ts';

/** A realistic page: chrome, an article, and a sidebar of links. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Understanding MCP — A Guide</title>
  <meta name="description" content="A short guide to the Model Context Protocol.">
  <meta property="og:title" content="Understanding MCP">
  <meta property="og:site_name" content="Example Blog">
  <meta property="article:published_time" content="2025-03-04T10:00:00Z">
  <style>body { color: red; }</style>
  <script>console.log('tracking');</script>
</head>
<body>
  <header>
    <nav><a href="/">Home</a><a href="/about">About</a><a href="/pricing">Pricing</a></nav>
  </header>

  <aside class="sidebar">
    <a href="/one">Related post one about widgets</a>
    <a href="/two">Related post two about gadgets</a>
    <a href="/three">Related post three about doodads</a>
  </aside>

  <article class="post">
    <h1>Understanding MCP</h1>
    <p>The Model Context Protocol is an open standard for connecting AI applications to external tools and data sources. It defines a client-server architecture.</p>
    <p>Adoption has grown steadily since release, with implementations available for TypeScript, Python and Rust. The protocol is transport agnostic, so it runs over stdio or HTTP.</p>
    <blockquote>MCP turns N integrations into one.</blockquote>
    <ul><li>Clients</li><li>Servers</li><li>Transports</li></ul>
  </article>

  <div class="newsletter">Subscribe to our newsletter for more updates about MCP.</div>

  <footer>
    <p>© 2025 Example. All rights reserved. <a href="/privacy">Privacy policy</a></p>
  </footer>
  <script>analytics.track();</script>
</body>
</html>`;

describe('HTML extraction', () => {
  test('pulls the article text and drops nav, sidebar and footer chrome', () => {
    const page = extractFromHtml(PAGE, 'https://example.com/mcp');

    assert.ok(page.text, 'expected extracted text');
    assert.match(page.text, /Model Context Protocol/);
    assert.match(page.text, /client-server architecture/);
    assert.match(page.text, /transport agnostic/);

    // chrome removed
    assert.ok(!/Home|About|Pricing/.test(page.text));
    assert.ok(!/Related post one/.test(page.text));
    assert.ok(!/All rights reserved|Privacy policy/.test(page.text));
    assert.ok(!/newsletter/i.test(page.text));
    assert.ok(!/analytics\.track|console\.log/.test(page.text));
  });

  test('reads metadata', () => {
    const page = extractFromHtml(PAGE, 'https://example.com/mcp');

    assert.equal(page.title, 'Understanding MCP');
    assert.equal(page.site_name, 'Example Blog');
    assert.match(page.description ?? '', /Model Context Protocol/);
    assert.equal(page.published_date, '2025-03-04T10:00:00.000Z');
  });

  test('counts words and detects language', () => {
    const page = extractFromHtml(PAGE, 'https://example.com/mcp');
    assert.ok((page.word_count ?? 0) > 30, `word_count was ${page.word_count}`);
    assert.equal(page.language, 'en');
  });

  test('respects maxChars', () => {
    const page = extractFromHtml(PAGE, 'https://example.com/mcp', { maxChars: 120 });
    assert.ok((page.text?.length ?? 0) <= 130, `length was ${page.text?.length}`);
  });

  test('falls back to body text on a page with no article markup', () => {
    const bare = '<html><body><p>Just a paragraph of content with enough words to clear the minimum threshold for extraction to accept it.</p></body></html>';
    const page = extractFromHtml(bare, 'https://example.com/bare');
    assert.match(page.text ?? '', /Just a paragraph/);
  });

  test('reports an error instead of throwing on empty pages', () => {
    const page = extractFromHtml('<html><body></body></html>', 'https://example.com/empty');
    assert.ok(page.error, 'expected an error field');
    assert.equal(page.text, undefined);
  });

  test('ignores script and style bodies when scoring blocks', () => {
    const scriptHeavy = `<html><body>
      <div class="content">
        <script>var x = '${'lorem ipsum '.repeat(40)}';</script>
        <p>Real content about the Model Context Protocol and how agents use it to reach live data sources on the open web.</p>
      </div>
    </body></html>`;
    const page = extractFromHtml(scriptHeavy, 'https://example.com/x');
    assert.match(page.text ?? '', /Real content about the Model Context Protocol/);
    assert.ok(!/lorem ipsum/.test(page.text ?? ''));
  });

  test('extracts list and quote content', () => {
    const page = extractFromHtml(PAGE, 'https://example.com/mcp');
    assert.match(page.text ?? '', /MCP turns N integrations into one/);
    assert.match(page.text ?? '', /Clients/);
  });

  test('blocks localhost and private IP URLs before fetching (SSRF guard)', async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('should not fetch');
    }) as typeof fetch;
    try {
      const localhost = await extractPage('http://localhost/admin');
      const loopback = await extractPage('http://127.0.0.1/latest/meta-data/');
      const privateNet = await extractPage('http://192.168.1.1/');
      assert.ok(localhost.error?.includes('Private or local'));
      assert.ok(loopback.error?.includes('Private or reserved'));
      assert.ok(privateNet.error?.includes('Private or reserved'));
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
