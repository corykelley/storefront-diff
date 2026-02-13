# StoreFront Diff

A Shopify embedded app that compares two themes from the same store and displays file-level diffs. Built with Remix, Prisma, BullMQ, and Polaris.

## What it does

1. Authenticates via Shopify OAuth (embedded in the Admin)
2. Lists all themes on the store
3. Lets you pick a **base** and **candidate** theme
4. Runs a background job that fetches every asset from both themes, compares them, and stores unified diffs
5. Displays results grouped by change type (added, removed, modified, skipped) with expandable inline diffs

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

You need to set `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`. The rest of the defaults work with the Docker setup below.

### 3. Start Postgres and Redis with Docker

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port `5432` (user: `postgres`, password: `postgres`, db: `storefront_diff`)
- **Redis 7** on port `6379`

To stop them later: `docker compose down` (add `-v` to also wipe the database volume).

### 4. Push the database schema

```bash
npx prisma db push
```

This creates all tables (Session, Shop, DiffRun, AssetDiff) in your local Postgres.

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

This starts the BullMQ worker that processes theme diff jobs. It fetches assets sequentially with throttling to stay within Shopify's API rate limits.

## Project structure

```
app/
  routes/
    _index.tsx                  # Auth entry point, redirects to /app
    app.tsx                     # Layout (Polaris + App Bridge)
    app._index.tsx              # Redirects to /app/diff
    app.diff._index.tsx         # Theme picker + recent runs
    app.diff.$diffRunId.tsx     # Diff results viewer
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
  index.ts                      # BullMQ worker (runs as separate process)
prisma/
  schema.prisma                 # Database schema
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Remix dev server (usually run via `shopify app dev`) |
| `npm run worker` | Start the BullMQ background worker |
| `npm run setup` | Generate Prisma client + push schema |
| `npm run prisma:studio` | Open Prisma Studio to inspect the DB |
| `npm run build` | Production build |
| `npm run typecheck` | Run TypeScript type checking |

## Tech stack

- **Remix** + TypeScript — full-stack framework
- **Prisma** + PostgreSQL — ORM and persistence
- **BullMQ** + Redis — background job queue
- **Shopify Admin REST API** — theme and asset data
- **Polaris** — Shopify's component library
- **App Bridge** — embedded app integration

## Notes

- The worker processes one job at a time with ~550ms delays between API calls to avoid Shopify's rate limits
- Binary and large files are skipped automatically
- The diff viewer auto-refreshes every 2 seconds while a job is running
