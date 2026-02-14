# StoreFront Diff — Architecture Overview

## What This App Does

StoreFront Diff is a Shopify embedded app that compares two themes from the same store. It answers the question: "If I publish this candidate theme instead of my current one, what will change?"

It does this three ways:

1. **File-level diffs** — Compares every Liquid template, CSS file, JS file, etc. between the two themes and shows unified diffs (like `git diff`).
2. **Visual diffs** — Takes full-page screenshots of key pages (home, product, collection, cart, custom) on both themes and highlights pixel-level differences.
3. **DOM regression checks** — Verifies that important elements (navigation links, add-to-cart buttons, price displays) still exist on the candidate theme.

## High-Level Architecture

```
┌──────────────────────────────────────────────────┐
│                  Shopify Admin                   │
│           (iframe embedding the app)             │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│              Remix Web Process                   │
│                                                  │
│  Routes:                                         │
│    /app/diff      — pick themes, see runs        │
│    /app/diff/:id  — view results (3 tabs)        │
│    /app/settings  — configure passwords, etc.    │
│                                                  │
│  On "Run Diff":                                  │
│    1. Creates DiffRun row in Postgres            │
│    2. Enqueues job to Redis via BullMQ           │
│    3. Redirects to results page                  │
│    4. Polls every 2-3s until complete            │
└──────────────┬───────────────────────────────────┘
               │ enqueue
               ▼
┌──────────────────────────────────────────────────┐
│              Redis (BullMQ Queue)                │
│              Queue name: "theme-diff"            │
└──────────────┬───────────────────────────────────┘
               │ dequeue
               ▼
┌──────────────────────────────────────────────────┐
│           Worker Process (separate)              │
│                                                  │
│  Phase 1: Asset diffs (Shopify REST API)         │
│  Phase 2: Page target resolution                 │
│  Phase 3: Per-target screenshots + checks        │
│  Phase 4: Finalize summary                       │
│                                                  │
│  Tools: Playwright, pixelmatch, pngjs            │
└──────────────┬───────────────────────────────────┘
               │ reads/writes
               ▼
┌──────────────────────────────────────────────────┐
│            PostgreSQL (via Prisma)                │
│                                                  │
│  DiffRun → AssetDiff                             │
│          → PageTarget → Screenshot               │
│                       → VisualDiff               │
│                       → CheckResult              │
└──────────────────────────────────────────────────┘
```

## Two Processes, One Database

The key architectural decision: the Remix web server and the worker are **separate Node processes**. They share the same PostgreSQL database (via Prisma) and communicate through Redis (via BullMQ).

**Why?** Screenshot capture with Playwright is slow and resource-heavy. If it ran inside the web process, it would block HTTP requests. By offloading to a worker, the web UI stays responsive.

**Consequence:** The worker needs its own copy of the Shopify access token. That's why `shopify.server.ts` has an `afterAuth` hook that persists the token to the `Shop` table — the worker reads it from there.

## Key Technologies

| Technology | What It Does Here |
|---|---|
| **Remix** | Full-stack React framework for the web app (routes, loaders, actions, SSR) |
| **Shopify Polaris** | UI component library that matches Shopify Admin's look and feel |
| **Shopify App Bridge** | Embeds the app inside Shopify Admin's iframe |
| **Prisma** | ORM for PostgreSQL — schema, migrations, typed queries |
| **BullMQ** | Job queue backed by Redis — enqueue from web, process in worker |
| **Playwright** | Headless Chromium for full-page screenshots |
| **pixelmatch** | Pixel-by-pixel image comparison (returns mismatch count) |
| **pngjs** | PNG encoding/decoding for image manipulation |
| **diff** | Text diffing library (generates unified patches) |

## File Structure at a Glance

```
storefront-diff/
├── app/                    # Remix web application
│   ├── routes/             # Page routes (URL → component)
│   ├── components/         # Shared React components
│   ├── lib/                # Server-side utilities
│   ├── shopify.server.ts   # Shopify auth config
│   └── db.server.ts        # Prisma singleton
├── worker/                 # Background worker (separate process)
│   ├── index.ts            # Main orchestrator (4-phase pipeline)
│   ├── screenshots.ts      # Playwright screenshot capture
│   ├── visualDiff.ts       # Pixel-level image comparison
│   ├── checks.ts           # DOM regression checks
│   ├── pageTargets.ts      # Page URL discovery
│   ├── shopifyFetch.ts     # Shopify API client (worker copy)
│   ├── storage.ts          # File storage abstraction
│   └── types.ts            # Shared TypeScript interfaces
├── prisma/
│   └── schema.prisma       # Database schema
├── public/                 # Static files + screenshot output
│   └── runs/{id}/          # Generated screenshots per diff run
├── docker-compose.yml      # Local Postgres + Redis
├── shopify.app.toml        # Shopify CLI app config
└── package.json            # Dependencies + scripts
```

## Next Steps

| Want to understand... | Read... |
|---|---|
| The database schema and data model | [01-database.md](./01-database.md) |
| How the web app routes work | [02-web-app.md](./02-web-app.md) |
| The worker pipeline in detail | [03-worker-pipeline.md](./03-worker-pipeline.md) |
| How screenshots are captured | [04-screenshots.md](./04-screenshots.md) |
| How visual diffs are computed | [05-visual-diff.md](./05-visual-diff.md) |
| DOM checks and regression detection | [06-checks.md](./06-checks.md) |
| Shopify auth, API calls, and rate limits | [07-shopify-integration.md](./07-shopify-integration.md) |
| The job queue and cancellation system | [08-job-queue.md](./08-job-queue.md) |
| The notification/toast system | [09-notifications.md](./09-notifications.md) |
| How to add new features | [10-extending.md](./10-extending.md) |
