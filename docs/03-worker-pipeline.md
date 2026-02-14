# Worker Pipeline

**File:** `worker/index.ts`
**Started with:** `npm run worker` (runs `tsx --watch worker/index.ts`)

The worker is a standalone Node process that dequeues jobs from Redis and executes the 4-phase diff pipeline.

## Startup

```typescript
const worker = new Worker("theme-diff", processDiffJob, {
  connection: { url: REDIS_URL },
  concurrency: 1,
  lockDuration: 600_000, // 10 minutes
});
```

- **Queue name:** `"theme-diff"` (must match the producer in `queue.server.ts`)
- **Concurrency:** 1 — only one job at a time. Playwright is resource-heavy.
- **Lock duration:** 10 minutes — if the worker doesn't heartbeat for 10 min, BullMQ considers the job stalled and retries it.

The worker also registers SIGINT/SIGTERM handlers for graceful shutdown (closes browser, worker, and Prisma connection).

## Job Data

Each job carries a single field:

```typescript
{ diffRunId: string }
```

The worker loads everything else (shop domain, access token, theme IDs) from the database.

## Job Processor — `processDiffJob()`

This is the main function. Here's the complete flow:

### Setup

```typescript
const diffRun = await prisma.diffRun.findUnique({ where: { id: diffRunId } });
const shop = await prisma.shop.findUnique({ where: { shopDomain: diffRun.shopDomain } });
await prisma.diffRun.update({ ... data: { status: "running" } });
```

1. Load the DiffRun record (throws if not found)
2. Load the Shop record to get the access token
3. Set status to `"running"`

Then build the `PipelineContext`:

```typescript
const ctx: PipelineContext = {
  diffRunId,
  shopDomain: diffRun.shopDomain,
  accessToken: shop.accessToken,
  baseThemeId: diffRun.baseThemeId,
  candidateThemeId: diffRun.candidateThemeId,
  prisma,
};
```

This context object is passed to every phase.

### Phase 1: Asset Diffs

**Function:** `runAssetDiffs(ctx)`

Compares all files between the two themes using the Shopify Admin REST API.

```
1. Fetch asset lists for both themes (parallel)
2. Classify into: added, removed, common
3. For each common file:
   a. Skip if binary (by extension)
   b. Fetch content from both themes
   c. Skip if > 500 KB
   d. Compare SHA256 hashes
   e. If different, generate unified diff
4. Bulk-insert AssetDiff records
```

**Rate limiting:** Sleeps 550ms between API calls to stay under Shopify's rate limit (~2 requests/second).

**Progress logging:** Every 10 assets: `[worker] Progress: 10/268 common assets compared`

**Cancellation check:** Every 10 assets, calls `assertNotCancelled(diffRunId)` which throws `JobCancelledError` if the DiffRun has been deleted.

**Returns:** `{ added: N, removed: N, modified: N, skipped: N }`

### Phase 2: Page Target Resolution

```typescript
const settings = await prisma.shopSetting.findUnique({ ... });
const targetDefs = await resolvePageTargets(ctx, settings?.customUrls);
const targetIds = await createPageTargetRecords(ctx, targetDefs);
```

1. Load shop settings (password, hide selectors, custom URLs)
2. Resolve page targets: home, cart, first product, first collection, plus custom URLs
3. Create PageTarget database records

See [04-screenshots.md](./04-screenshots.md) for details on page target resolution.

### Phase 3: Per-Target Processing

For each page target, the pipeline runs:

```
for each target:
  a. Capture base screenshot → keep page open
  b. Run DOM checks on base page → close browser context
  c. Capture candidate screenshot → keep page open
  d. Run DOM checks on candidate page → close browser context
  e. Generate visual diff (pixelmatch)
  f. Persist check results → detect regressions
  g. Mark target complete
```

**Why keep the page open?** DOM checks run on the live Playwright `Page` object after the screenshot is taken. This avoids navigating twice.

**Error isolation:** Each target is wrapped in try/catch. If one target fails (e.g., timeout), the others still run. Failed targets get `status: "failed"` and `errorMessage`.

**Cancellation check:** Before each target, calls `assertNotCancelled()`.

### Phase 4: Finalization

```typescript
await closeBrowser();

const summary = {
  ...assetResult,
  pageTargets: targetIds.length,
  screenshotsComplete,
  screenshotsFailed,
  maxMismatchPercent,
  riskCount: allRegressions.length,
  regressions: allRegressions,
};

await prisma.diffRun.update({
  where: { id: diffRunId },
  data: {
    status: allTargetsFailed ? "failed" : "complete",
    summary,
  },
});
```

1. Closes the Playwright browser
2. Computes summary object (stored as JSON on the DiffRun)
3. Sets final status

If ALL targets failed, the run itself is marked `"failed"`. If at least one succeeded, it's `"complete"`.

## Error Handling

The entire try block is wrapped in a catch:

```typescript
catch (err) {
  await closeBrowser();
  if (err instanceof JobCancelledError) {
    console.log(`[worker] Job cancelled: ${diffRunId}`);
    return; // nothing to update — row was deleted
  }
  // Update DiffRun with error status
  await prisma.diffRun.update({
    data: { status: "failed", errorMessage: err.message },
  });
  throw err; // BullMQ marks the job as failed
}
```

Three error categories:
1. **JobCancelledError** — User deleted the run. Log and return silently.
2. **Target-level errors** — Caught inside the per-target loop. Other targets continue.
3. **Pipeline-level errors** — Caught here. Entire run marked failed.

## Cancellation System

When a user deletes a running diff:

1. **Web app** deletes the DiffRun row from the database
2. **Worker** periodically calls `assertNotCancelled(diffRunId)`, which does:
   ```typescript
   const run = await prisma.diffRun.findUnique({ where: { id: diffRunId } });
   if (!run) throw new JobCancelledError(diffRunId);
   ```
3. The error propagates up, the outer catch handles it gracefully

Checkpoints where cancellation is detected:
- Every 10 assets during Phase 1
- Between Phase 1 and Phase 2
- Before each page target in Phase 3

## Configuration Constants

| Constant | Value | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection for BullMQ |
| `MAX_ASSET_SIZE` | 500 KB | Files larger than this are skipped |
| `THROTTLE_MS` | 550ms | Delay between Shopify API calls |
| `BINARY_EXTENSIONS` | `.png`, `.jpg`, `.woff`, etc. | Files to skip (no text content) |

## Lifecycle Summary

```
Job queued
  │
  ├─ processDiffJob() called
  │    ├─ Load DiffRun + Shop
  │    ├─ Set status = "running"
  │    │
  │    ├─ Phase 1: Asset diffs
  │    │    └─ (cancellation checks every 10 assets)
  │    │
  │    ├─ Phase 2: Page target resolution
  │    │
  │    ├─ Phase 3: Per-target processing
  │    │    ├─ Target 1: screenshots → checks → visual diff ✓
  │    │    ├─ Target 2: screenshots → checks → visual diff ✓
  │    │    ├─ Target 3: screenshots → checks → visual diff ✗ (failed)
  │    │    └─ Target 4: screenshots → checks → visual diff ✓
  │    │
  │    └─ Phase 4: Finalize
  │         ├─ Close browser
  │         ├─ Compute summary
  │         └─ Set status = "complete"
  │
  └─ Job complete
```
