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
| `npm test`        | Unit tests for providers, federation/ranking, intent, languages, extraction, answers and pipeline |
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
│   ├── federation.ts       # Parallel multi-provider search + partial-failure handling
│   ├── ranking.ts          # URL dedupe and relevance/freshness/authority ranking
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

`POST /api/v1/search` accepts a natural-language query and a provider key, then returns detected
language, inspectable query intent, an optional cited answer, and optionally extracted page text.
With multiple provider keys configured, it searches those providers in parallel, deduplicates and
reranks their live results as one set. The playground uses the same pipeline at `POST /api/search`.

Additional endpoints:

- `POST /api/v1/intent` — classify a query, detect language/entities, infer recency, and rewrite it
  for a search index. No provider key required.
- `POST /api/v1/extract` — fetch and clean up to ten public URLs, optionally including their page images and alt text. Private/local IPs and redirects to them are blocked.
- `POST /api/v1/images` — live image search through Brave Images or Serper Images, normalized to image, thumbnail, source-page and dimension fields.

Supported search providers — `tavily`, `brave`, `serper`, `exa` — are implemented in
[`src/lib/search.ts`](src/lib/search.ts). Multi-source fan-out uses each configured provider-specific
environment key and the visitor's key only for the visitor-selected provider. Set
`multi_source: false` to use just the selected provider. Each returned result includes provider
provenance, corroboration count, and an explainable ranking score. That score is an ordering heuristic,
not a confidence probability; confidence scoring and personalized ranking are deferred.

### Where the key comes from

1. `x-xweb-key` request header (what the playground sends), or `api_key` in the body; it is bound to the selected provider only.
2. The matching provider-specific server key (for example, `BRAVE_API_KEY`) or the generic `XWEB_SEARCH_API_KEY` associated with `XWEB_SEARCH_PROVIDER`.
3. Otherwise the request fails with `401 missing_api_key`.

Other configured provider-specific keys may be used for the same federated query, but a visitor key
is never reused as another provider's credential. Request keys are not persisted or written to browser storage.

### Accounts and the developer dashboard

`/login` supports email/password and Google through Supabase Auth. `/dashboard` shows the account's
Free plan label, monthly usage and recent requests, and supports creating (shown once) and revoking
x-web API keys. Account keys are stored as SHA-256 hashes. The dashboard also lets each account
connect Tavily, Brave Search, Serper, and Exa credentials. Provider keys are AES-GCM encrypted before
database storage and are never returned to the browser after saving; account-key searches use those
credentials alongside any deployment-configured providers. The dashboard also supports AI Bring Your
Own Key for OpenAI, Anthropic, and Groq; saved AI keys are encrypted at rest and used for that account's
answer synthesis, while requests without a personal AI key use the server-managed default model when
configured and then fall back to provider/extractive answers.

This is an account foundation, not a billing launch: paid subscriptions, plan changes and quota
enforcement are not enabled. Apply
[`supabase/migrations/202610160001_account_dashboard.sql`](supabase/migrations/202610160001_account_dashboard.sql)
and enable Email in Supabase Auth. Because Astro statically builds `/login` and `/dashboard`, add
`PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` to Vercel Preview (and Production when ready),
using the same project URL and public anon/publishable key as the Supabase integration variables.
These two values are public; never put `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in a
`PUBLIC_` variable. To enable dashboard provider-key storage, also apply
[`supabase/migrations/202610160002_provider_credentials.sql`](supabase/migrations/202610160002_provider_credentials.sql)
and set `XWEB_PROVIDER_KEY_ENCRYPTION_KEY` to a random secret of at least 32 bytes in Vercel Preview
and Production. Use the **same value** in both environments so saved credentials remain readable
across deployments (generate one with `openssl rand -base64 32`). Google OAuth is optional and can
be configured later.

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
| `XWEB_IMAGE_SEARCH_PROVIDER` | Default image provider: `brave` or `serper`                 |
| `XWEB_IMAGE_SEARCH_API_KEY` | Optional dedicated server-side image search key               |
| `PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | Supabase project URL (public browser value and server value) |
| `PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` | Server-only Supabase key for account, API-key and usage operations |
| `XWEB_PROVIDER_KEY_ENCRYPTION_KEY` | Random 32+ byte server-only secret for encrypting saved search and AI credentials |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GROQ_API_KEY` | Optional x-web-managed default AI model keys (used when the account has no BYOK key) |
| `XWEB_ANSWER_MODEL` | Optional server-managed default model override |
| `XWEB_API_BASE`          | Forward to a real x-web deployment instead of a provider       |
| `SITE_URL`               | Canonical site URL used for canonical links and the sitemap     |

---

## Deploying to Vercel

The repository is already connected to Vercel, so pushing is enough:

1. `npm run build` must pass (Vercel runs `npm run build` and installs with `npm ci`).
2. Push to the branch — Vercel creates a preview deployment for every branch.
3. Add `SITE_URL` and any provider keys in **Project Settings → Environment Variables**.

The Vercel adapter prerenders the documentation pages and dispatches the non-prerendered `/api/*`
routes through the serverless handler.

---

## Content to review before launch

The copy for the product itself is written as a working draft — adjust it to match reality:

- **Pricing** on the landing page is placeholder copy.
- The **`/v1/*` API surface** documented in `src/pages/docs/api.astro` is the intended spec; keep
  it in sync with the real service.
- The **SDK snippets** reference `x-web` packages that are not published yet.

## License

MIT
