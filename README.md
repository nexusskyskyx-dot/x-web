# x-web

> Give your AI access to the web with x-web

The marketing site and developer documentation for **x-web** — one API for web search, scraping,
extraction and crawling, so an AI agent can read the live web instead of guessing.

Built with **Astro 7** + **Tailwind CSS 4** in a purple-and-white theme, and deployed on Vercel.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:4321
```

| Script            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Dev server on `0.0.0.0:4321` (so preview hosts work)      |
| `npm run build`   | Production build (static pages + Vercel serverless routes) |
| `npm run preview` | Serve the production build locally                        |
| `npm run check`   | Astro + TypeScript diagnostics                            |
| `npm test`        | Unit tests for providers, intent, languages, extraction, answers and pipeline |
| `npm run test:layout` | Builds, then fails if anything can force horizontal page scroll |

---

## What's in here

```
src/
├── components/          # UI building blocks
│   ├── CodeBlock.astro     # Shiki-highlighted code + copy button
│   ├── CodeTabs.astro      # Tabbed code samples (cURL / Python / Node…)
│   ├── Callout.astro       # Note, tip, warning, danger
│   ├── Endpoint.astro      # HTTP method + path header
│   ├── ParamTable.astro    # Request parameter tables
│   ├── Playground.astro    # Live search playground
│   ├── Nav.astro / Footer.astro / Icons.astro
├── layouts/
│   ├── Base.astro          # HTML shell, meta, nav, footer
│   └── Docs.astro          # Docs shell with sidebar + on-this-page TOC
├── lib/
│   ├── search.ts           # Provider adapters (Tavily, Brave, Serper, Exa)
│   └── search.test.ts      # node:test suite for those adapters
├── pages/
│   ├── index.astro         # Landing page
│   ├── docs/               # index, quickstart, api, mcp, providers
│   └── api/                 # playground proxy + v1 search, intent, extract
├── lib/                     # provider adapters, intent, language, answers, extraction
└── styles/global.css       # Tailwind theme tokens (purple + white)
```

The docs pages are prerendered HTML. The API routes opt out of prerendering and are deployed as
Vercel serverless functions.

---

## The search proxy

`POST /api/v1/search` is the first public API surface. It accepts a natural-language query and a
provider key, then returns live provider results, detected language, inspectable query intent,
optional cited answer synthesis, and optionally extracted page text. The playground uses the same
pipeline at `POST /api/search`.

Additional endpoints:

- `POST /api/v1/intent` — classify a query, detect language/entities, infer recency, and rewrite it
  for a search index. No provider key required.
- `POST /api/v1/extract` — fetch and clean up to ten public URLs. Private/local IPs and redirects
  to them are blocked.

Supported search providers — `tavily`, `brave`, `serper`, `exa` — are implemented in
[`src/lib/search.ts`](src/lib/search.ts). The pipeline, language detector, extractive answerer,
page extractor and provider adapters are all covered by tests.

### Where the key comes from

1. `x-xweb-key` request header (what the playground sends), or `api_key` in the body
2. `XWEB_SEARCH_API_KEY` server environment variable
3. Otherwise the request fails with `401 missing_api_key`

The key is used for that single request only. It is never stored, never logged, and never written
to the browser's storage.

### What is not live yet

x-web does not yet issue its own API keys or accounts. There is no account creation, plan selection,
subscription or payment flow in this milestone. Users currently supply a key for one of the four
supported search providers, or the site owner configures a provider key server-side. The future
account/billing layer can replace that credential model without changing these search, intent and
extraction contracts.

---

## Environment variables

Copy [`.env.example`](.env.example) to `.env` for local development, or add them in your Vercel
project settings.

| Variable                 | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `XWEB_SEARCH_PROVIDER`   | Default provider: `tavily`, `brave`, `serper` or `exa`         |
| `XWEB_SEARCH_API_KEY`    | Server-side key used when the visitor does not paste one       |
| `TAVILY_API_KEY`         | Tavily key (also used as the fallback for `XWEB_SEARCH_PROVIDER`) |
| `BRAVE_API_KEY`          | Brave Search key                                               |
| `SERPER_API_KEY`         | Serper key                                                     |
| `EXA_API_KEY`            | Exa key                                                        |
| `XWEB_API_BASE`          | Forward to a real x-web deployment instead of a provider       |
| `SITE_URL`               | Canonical site URL used for canonical links and the sitemap     |

---

## Deploying to Vercel

The repository is already connected to Vercel, so pushing is enough:

1. `npm run build` must pass (Vercel runs `npm run build` and installs with `npm ci`).
2. Push to the branch — Vercel creates a preview deployment for every branch.
3. Add `SITE_URL` and any provider keys in **Project Settings → Environment Variables**.

The Vercel adapter reads `output: "static"` plus the two non-prerendered `/api/*` routes and
emits a static bundle plus one serverless function.

---

## Content to review before launch

The copy for the product itself is written as a working draft — adjust it to match reality:

- **Pricing** on the landing page is placeholder copy.
- The **`/v1/*` API surface** documented in `src/pages/docs/api.astro` is the intended spec; keep
  it in sync with the real service.
- The **SDK snippets** reference `x-web` packages that are not published yet.

## License

MIT
