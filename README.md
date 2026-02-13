# StoreFront Diff

A Shopify embedded app that compares two themes from the same store — file-level diffs, visual screenshot comparisons, and automated DOM regression checks. Built with Remix, Prisma, BullMQ, Playwright, and Polaris.

## What it does

1. Authenticates via Shopify OAuth (embedded in the Admin)
2. Lists all themes on the store
3. Lets you pick a **base** and **candidate** theme
4. Runs a background job that:
   - Fetches every asset from both themes and generates unified diffs
   - Auto-discovers page targets (home, product, collection, cart) via the Shopify API
   - Captures full-page screenshots of each page on both themes using Playwright
   - Generates pixel-level visual diffs with pixelmatch
   - Runs DOM regression checks (e.g. "is the Add to Cart button present?")
5. Displays results across three tabs:
   - **Files** — asset diffs grouped by change type with expandable inline diffs
   - **Visual** — side-by-side screenshots (base / candidate / diff) with mismatch percentages
   - **Checks** — DOM regression results showing pass/fail per check per theme

## Prerequisites

- **Node.js** >= 20
- **Docker** (for Postgres + Redis)
- **Shopify CLI** (`npm install -g @shopify/cli`)
- A [Shopify Partner](https://partners.shopify.com/) account with an app created

## Getting started

### 1. Clone and install

```bash
git clone git@github.com:corykelley/storefront-diff.git
cd storefront-diff
npm install
```

### 2. Environment variables

Copy the example env file and fill in your Shopify app credentials from the Partners Dashboard:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | Yes | App API key from Partners Dashboard |
| `SHOPIFY_API_SECRET` | Yes | App API secret |
| `SHOPIFY_APP_URL` | No | Auto-set by Shopify CLI (Cloudflare tunnel) |
| `SCOPES` | No | Defaults to `read_themes,read_products` |
| `DATABASE_URL` | No | Defaults to local Docker Postgres |
| `REDIS_URL` | No | Defaults to `redis://localhost:6379` |

### 3. Start Postgres and Redis with Docker

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port `5432` (user: `postgres`, password: `postgres`, db: `storefront_diff`)
- **Redis 7** on port `6379`

To stop them later: `docker compose down` (add `-v` to also wipe the database volume).

### 4. Run setup

```bash
npm run setup
```

This generates the Prisma client, pushes the database schema, and installs the Playwright Chromium browser.

### 5. Configure your Shopify app

Make sure `shopify.app.toml` has your app's `client_id`. The Shopify CLI will handle the rest:

```bash
npx shopify app dev
```

On first run it will:
- Ask you to select your app and dev store
- Create a Cloudflare tunnel
- Update your app's URLs automatically

### 6. Start the background worker

In a **separate terminal**:

```bash
npm run worker
```

This starts the BullMQ worker that processes theme diff jobs. The worker runs a 4-phase pipeline:

1. **Asset diffs** — fetches and compares theme files with throttled API calls
2. **Page target resolution** — discovers home, product, collection, and cart pages
3. **Per-target processing** — screenshots, visual diffs, and DOM checks for each page
4. **Finalization** — aggregates summary stats and closes the browser

### 7. Configure settings (optional)

In the app, go to **Settings** to configure:

- **Storefront password** — required if your dev store is password-protected
- **Hide selectors** — CSS selectors for elements to hide during screenshots (e.g. chat widgets, cookie banners)

## Project structure

```
app/
  routes/
    _index.tsx                  # Auth entry point, redirects to /app
    app.tsx                     # Layout (Polaris + App Bridge)
    app._index.tsx              # Redirects to /app/diff
    app.diff._index.tsx         # Theme picker + recent runs
    app.diff.$diffRunId.tsx     # Diff results viewer (Files / Visual / Checks tabs)
    app.settings.tsx            # Shop settings (password, hide selectors)
    auth.login.tsx              # Login form (non-embedded fallback)
    auth.$.tsx                  # OAuth callback handler
    auth.exit-iframe.tsx        # Breaks out of iframe for OAuth
    webhooks.tsx                # Webhook handler
  shopify.server.ts             # Shopify app config
  db.server.ts                  # Prisma client
  lib/
    queue.server.ts             # BullMQ queue setup
    shopify-api.server.ts       # Shopify REST API helpers
worker/
  index.ts                      # Pipeline orchestrator (runs as separate process)
  pageTargets.ts                # Auto-discovers pages to screenshot
  screenshots.ts                # Playwright screenshot capture
  visualDiff.ts                 # pixelmatch visual comparison
  checks.ts                     # DOM regression checks
  shopifyFetch.ts               # API wrapper with retry + rate limit handling
  storage.ts                    # Storage abstraction (local filesystem / S3)
  types.ts                      # Shared TypeScript interfaces
prisma/
  schema.prisma                 # Database schema
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Remix dev server (usually run via `shopify app dev`) |
| `npm run dev:shopify` | Start via Shopify CLI with tunnel |
| `npm run worker` | Start the BullMQ background worker |
| `npm run setup` | Generate Prisma client + push schema + install Playwright Chromium |
| `npm run prisma:studio` | Open Prisma Studio to inspect the DB |
| `npm run build` | Production build |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |

## Tech stack

- **Remix** + TypeScript — full-stack framework
- **Prisma** + PostgreSQL — ORM and persistence
- **BullMQ** + Redis — background job queue
- **Playwright** — headless browser for screenshot capture
- **pixelmatch** + pngjs — pixel-level visual diff generation
- **Shopify Admin REST API** — theme, asset, product, and collection data
- **Polaris** — Shopify's component library
- **App Bridge** — embedded app integration

## Notes

- The worker processes one job at a time with a 10-minute lock duration to accommodate Playwright operations
- API calls are throttled at ~550ms between requests to stay within Shopify's rate limits
- Failed API requests are retried up to 5 times with exponential backoff
- Binary and large files (>500 KB) are skipped during asset diffing
- Screenshots are normalized: animations/transitions are frozen, and images are padded to matching dimensions before diffing
- The diff viewer auto-refreshes every 2 seconds while a job is running
- Regression detection flags cases where a DOM check passes on base but fails on candidate
