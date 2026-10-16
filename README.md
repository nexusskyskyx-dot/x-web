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
| `npm test`        | Unit tests for the search provider adapters                |
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
│   └── api/search.ts       # Serverless search proxy
└── styles/global.css       # Tailwind theme tokens (purple + white)
```

The site is **static by default** — every docs page is prerendered HTML. Only `/api/search` opts out
of prerendering (`export const prerender = false`) and is deployed as a Vercel serverless function.

---

## The search proxy

`POST /api/search` is a thin, provider-agnostic proxy. It takes a query plus a provider key and
returns one normalised x-web response:

```json
{
  "id": "xweb_9f3c1a20",
  "query": "astro v7 release notes",
  "provider": "tavily",
  "answer": "Astro 7.4.0 ships with Vite 8…",
  "results": [{ "title": "…", "url": "…", "snippet": "…", "score": 0.98 }],
  "took_ms": 412
}
```

Supported providers — `tavily`, `brave`, `serper`, `exa` — are implemented in
[`src/lib/search.ts`](src/lib/search.ts) and covered by unit tests.

### Where the key comes from

1. `x-xweb-key` request header (what the playground sends), or `api_key` in the body
2. `XWEB_SEARCH_API_KEY` server environment variable
3. Otherwise the request fails with `401 missing_api_key`

The key is used for that single request only. It is never stored, never logged, and never written
to the browser's storage.

### Pointing the proxy at a real x-web deployment

Set `XWEB_API_BASE` (for example `https://api.x-web.dev/v1`) and the proxy forwards the request to
`{XWEB_API_BASE}/search` with a bearer token instead of calling a search provider. The documented
response shape stays the same, so the playground keeps working once the hosted API is live.

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
