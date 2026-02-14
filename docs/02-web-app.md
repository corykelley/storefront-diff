# Web App (Remix Routes & UI)

The web app is a standard Remix application embedded inside Shopify Admin via an iframe. It uses Shopify Polaris for UI components and Shopify App Bridge for iframe communication.

## How Remix Routes Work

Remix uses file-based routing. Each file in `app/routes/` maps to a URL:

| File | URL | Purpose |
|---|---|---|
| `_index.tsx` | `/` | OAuth entry point, redirects to `/app` |
| `app.tsx` | `/app` (layout) | Nav shell wrapping all `/app/*` routes |
| `app._index.tsx` | `/app` | Redirects to `/app/diff` |
| `app.diff._index.tsx` | `/app/diff` | Theme picker + recent runs |
| `app.diff.$diffRunId.tsx` | `/app/diff/:id` | Results viewer (3 tabs) |
| `app.settings.tsx` | `/app/settings` | Shop settings form |
| `auth.login.tsx` | `/auth/login` | Non-embedded OAuth login |
| `auth.$.tsx` | `/auth/*` | OAuth callback handler |
| `auth.exit-iframe.tsx` | `/auth/exit-iframe` | Breaks out of iframe for OAuth |
| `webhooks.tsx` | `/webhooks` | Shopify webhook handler |

Each route can export:
- **`loader`** — Runs on GET requests (fetches data for the page)
- **`action`** — Runs on POST requests (handles form submissions)
- **`default`** — The React component to render

## Authentication Flow

Every route that needs Shopify data calls `authenticate.admin(request)` in its loader/action. This:

1. Validates the request came from Shopify Admin (checks JWT signature)
2. Returns `{ session }` with `session.shop` and `session.accessToken`
3. If auth fails, redirects through the OAuth flow automatically

**Special case:** `_index.tsx` must authenticate _before_ redirecting to `/app` because the Shopify CLI proxy drops query parameters during redirects. The auth params (`shop`, `host`, `embedded`, `id_token`) would be lost.

**Special case:** `auth.exit-iframe.tsx` must NOT call `authenticate.admin()` or it would create an infinite redirect loop. It uses a plain HTML response with `window.top.location.href` to navigate the parent window out of the iframe.

## Route: Theme Picker (`app.diff._index.tsx`)

**File:** `app/routes/app.diff._index.tsx`

This is the main entry point for running diffs.

### Loader

```typescript
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const themes = await listThemes(session.shop, session.accessToken);
  const recentRuns = await prisma.diffRun.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return json({ themes, recentRuns });
};
```

Fetches all themes from the Shopify API and the 10 most recent diff runs from the database.

### Action — Creating a Run

When the user clicks "Run Diff":

1. Validates both themes are selected and different
2. Creates a `DiffRun` record with status `"queued"`
3. Enqueues a BullMQ job with the `diffRunId`
4. Redirects to `/app/diff/{diffRunId}`

```typescript
const diffRun = await prisma.diffRun.create({
  data: { shopDomain, baseThemeId, candidateThemeId, ... status: "queued" },
});
await enqueueDiffJob(diffRun.id);
return redirect(`/app/diff/${diffRun.id}`);
```

### Action — Deleting a Run

When the user clicks "Delete" on a run:

1. Cancels any BullMQ job (removes queued jobs; active jobs self-cancel)
2. Deletes the `public/runs/{id}/` directory
3. Deletes the `DiffRun` record (cascades to all related data)
4. Returns `{ deleted: true, jobCancelled: true/false }`

### Polling

The component polls every 3 seconds while any run has status `queued` or `running`:

```typescript
useEffect(() => {
  if (!hasActiveRuns) return;
  const interval = setInterval(() => revalidator.revalidate(), 3000);
  return () => clearInterval(interval);
}, [hasActiveRuns]);
```

`revalidator.revalidate()` re-runs the loader, fetching fresh data from the database.

### Completion Detection

The component tracks which run IDs were previously active. When a run disappears from the active set, it shows a toast:

```typescript
const prevActiveIdsRef = useRef<Set<string>>(...);

useEffect(() => {
  for (const id of prevActiveIdsRef.current) {
    if (!currentActiveIds.has(id)) {
      // Run finished — show toast
    }
  }
  prevActiveIdsRef.current = currentActiveIds;
}, [recentRuns]);
```

### RunRow Component

Each recent run renders as a card with:
- Theme names (`base → candidate`)
- Timestamp and status badge
- "View" link to results page
- "Delete" button with confirmation modal

Delete uses `useFetcher()` to submit without navigating away from the page.

## Route: Results Viewer (`app.diff.$diffRunId.tsx`)

**File:** `app/routes/app.diff.$diffRunId.tsx`

This is the most complex route. It displays results across three tabs.

### Loader

Fetches the full DiffRun with all nested data:

```typescript
const run = await prisma.diffRun.findUnique({
  where: { id: params.diffRunId },
  include: {
    assetDiffs: { orderBy: { key: "asc" } },
    pageTargets: {
      include: { screenshots: true, visualDiffs: true, checkResults: true },
    },
  },
});
```

**BigInt serialization:** Shopify theme IDs are `BigInt`, which can't be serialized to JSON. The loader converts them to strings before returning.

### Polling While Running

```typescript
useEffect(() => {
  if (status !== "queued" && status !== "running") return;
  const interval = setInterval(() => revalidator.revalidate(), 2000);
  return () => clearInterval(interval);
}, [status]);
```

Polls every 2 seconds (faster than the list page) until the run completes.

### Files Tab

Groups `AssetDiff` records by change type:

```
Added (3)      — green badge
Removed (1)    — red badge
Modified (12)  — yellow badge, expandable diffs
Skipped (5)    — gray badge
```

Modified files have a "Show diff" button that expands to show the unified diff in a `<pre>` block.

### Visual Tab

For each PageTarget:
- Three-column layout: Base screenshot | Candidate screenshot | Diff image
- Mismatch percentage badge
- Click any image to open a zoom modal
- Zoom modal has tabs to switch between Base/Candidate/Diff

Images are served as static files from `public/runs/{id}/`.

### Checks Tab

Displays a table of DOM check results:

| Check Name | Page Type | Base | Candidate |
|---|---|---|---|
| PDP_ATC_PRESENT | product | Pass | Fail |

If any check regresses (base passes, candidate fails), a critical banner appears at the top.

## Route: Settings (`app.settings.tsx`)

**File:** `app/routes/app.settings.tsx`

Simple form with three fields:

1. **Storefront password** — Password input for protected stores
2. **Hide selectors** — Multiline textarea for CSS selectors to hide
3. **Custom URLs** — Multiline textarea for additional page paths

The action upserts a `ShopSetting` record. Empty strings are stored as `null`.

### How Settings Are Consumed

The worker loads settings before Phase 2:

```typescript
const settings = await prisma.shopSetting.findUnique({
  where: { shopDomain: diffRun.shopDomain },
});
```

- `storefrontPassword` → passed to `captureScreenshot()` for password-protected stores
- `hideSelectors` → CSS injected into page to hide elements before screenshot
- `customUrls` → parsed into additional `PageTargetDef` entries

## Layout Route (`app.tsx`)

**File:** `app/routes/app.tsx`

Wraps all `/app/*` routes with:

```tsx
<AppProvider isEmbeddedApp apiKey={apiKey}>
  <NavMenu>
    <Link to="/app" rel="home">Home</Link>
    <Link to="/app/diff">Theme Diff</Link>
    <Link to="/app/settings">Settings</Link>
  </NavMenu>
  <Outlet />           {/* nested route renders here */}
  <NotificationHost /> {/* toast notifications */}
</AppProvider>
```

- `AppProvider` initializes Shopify App Bridge (iframe communication)
- `NavMenu` renders the left sidebar navigation
- `NotificationHost` renders the global toast stack

## Webhook Route (`webhooks.tsx`)

Handles Shopify webhook events:

- **APP_UNINSTALLED** — Cleans up: deletes sessions and shop record
- **CUSTOMERS_DATA_REQUEST / CUSTOMERS_REDACT / SHOP_REDACT** — GDPR compliance (no-op since we don't store customer data)

Webhook signatures are verified by `authenticate.webhook()` before any processing.

## Server-Side Utilities

### `db.server.ts`

Prisma client singleton. Uses a global variable to survive hot reloads in development:

```typescript
const prisma = globalThis.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;
export default prisma;
```

### `shopify.server.ts`

Shopify app configuration. Key parts:

- **Session storage:** Prisma-backed (`@shopify/shopify-app-session-storage-prisma`)
- **`afterAuth` hook:** Persists shop domain + access token to `Shop` table
- **Exports:** `authenticate`, `login`, `registerWebhooks`, `sessionStorage`, etc.

### `lib/shopify-api.server.ts`

Shopify REST API client used by the web process (theme listing). Has its own rate-limit retry logic (3 retries, 1s initial backoff). The worker has a separate copy (`worker/shopifyFetch.ts`) with more aggressive retries (5 retries, 2s initial backoff).

### `lib/queue.server.ts`

BullMQ queue producer. See [08-job-queue.md](./08-job-queue.md) for details.
