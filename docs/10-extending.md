# Extending StoreFront Diff

Common modifications you might want to make, with guidance on where to change what.

## Add a New Page Type to Screenshot

**Example:** Screenshot the `/collections` page (all collections listing).

1. **Add to auto-discovery** in `worker/pageTargets.ts`:
   ```typescript
   const targets: PageTargetDef[] = [
     { pageType: "home", path: "/" },
     { pageType: "cart", path: "/cart" },
     { pageType: "collections", path: "/collections" },  // ← add this
   ];
   ```

That's it. The pipeline automatically handles screenshots, visual diffs, and file naming for any new page type.

## Add a New DOM Check

**Example:** Verify the footer exists on the home page.

1. **Add the check name** to `worker/types.ts`:
   ```typescript
   export type CheckName =
     | "HOME_NAV_LINKS_PRESENT"
     | "HOME_FOOTER_PRESENT"  // ← add this
     | ...
   ```

2. **Add the check definition** to `worker/checks.ts`:
   ```typescript
   {
     name: "HOME_FOOTER_PRESENT",
     pageTypes: ["home"],
     selector: 'footer, [role="contentinfo"], .site-footer',
   },
   ```

The pipeline will automatically run this check, save results, and detect regressions.

## Add a New Setting

**Example:** Add a "viewport width" setting so users can choose mobile vs desktop.

1. **Add the field** to `prisma/schema.prisma`:
   ```prisma
   model ShopSetting {
     // ...existing fields...
     viewportWidth  Int?  // null = default (1440)
   }
   ```

2. **Run schema sync:**
   ```bash
   npx prisma db push && npx prisma generate
   ```

3. **Add to the Settings UI** in `app/routes/app.settings.tsx`:
   - Add to the loader return value
   - Add to the action form data parsing and upsert
   - Add a TextField or Select in the component
   - Add to the state and handleSave callback

4. **Use it in the worker** in `worker/index.ts`:
   ```typescript
   const viewportWidth = settings?.viewportWidth ?? 1440;
   ```
   Then pass it to `capturePageTargetScreenshots()` → `captureScreenshot()` → use in `viewport` option.

5. **Update `screenshots.ts`** to accept the viewport width as a parameter instead of using the `VIEWPORT` constant.

## Change the Screenshot Viewport

**File:** `worker/screenshots.ts`

```typescript
const VIEWPORT = { width: 1440, height: 900 };
```

Change this to any resolution. Common choices:
- `1440x900` — Standard desktop
- `1920x1080` — Full HD
- `375x812` — iPhone X (mobile)
- `768x1024` — iPad (tablet)

**Note:** The viewport height mostly doesn't matter because screenshots use `fullPage: true`. But it affects above-the-fold layout and viewport-dependent CSS breakpoints.

## Change the pixelmatch Threshold

**File:** `worker/visualDiff.ts`

```typescript
{ threshold: 0.05, includeAA: true }
```

- **Lower threshold (e.g., 0.01):** More sensitive, catches subtler changes
- **Higher threshold (e.g., 0.1):** More tolerant, ignores minor variations
- **`includeAA: false`:** Ignores anti-aliasing differences (reduces noise from font rendering)

## Add S3 Storage for Screenshots

**File:** `worker/storage.ts`

The `S3StorageProvider` class is already stubbed out. To implement it:

```typescript
class S3StorageProvider implements StorageProvider {
  async write(relativePath: string, data: Buffer): Promise<void> {
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: relativePath,
      Body: data,
      ContentType: "image/png",
    }));
  }

  publicUrl(relativePath: string): string {
    return `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${relativePath}`;
  }
}
```

Set `STORAGE_PROVIDER=s3` in your `.env` to activate it.

**Also update:** The `visualDiff.ts` file currently reads screenshots from `./public/` via `readFile()`. With S3 storage, you'd need to change it to read from S3 (or pass buffers directly instead of file paths).

## Add More Asset Diff Context

**File:** `worker/index.ts` in `runAssetDiffs()`

The unified diff uses 3 lines of context:

```typescript
const patch = createTwoFilesPatch(
  `base/${key}`,
  `candidate/${key}`,
  baseContent,
  candidateContent,
  undefined,
  undefined,
  { context: 3 },  // ← change this
);
```

Increase `context` for more surrounding lines in the diff output.

## Increase Worker Concurrency

**File:** `worker/index.ts`

```typescript
const worker = new Worker("theme-diff", processDiffJob, {
  concurrency: 1,  // ← change this
});
```

Setting this higher means multiple jobs run simultaneously. **Caution:**
- Each job launches Playwright and uses significant memory
- The global `browser` variable in `screenshots.ts` is shared — you'd need to make browser management per-job
- Shopify API rate limits are per-app-per-store, so concurrent jobs for the same store would hit limits faster

## Add Mobile Screenshots

One approach: run each page target twice (desktop + mobile).

1. **Add a mobile viewport constant** to `screenshots.ts`:
   ```typescript
   const MOBILE_VIEWPORT = { width: 375, height: 812 };
   ```

2. **Modify the per-target loop** in `worker/index.ts` to capture two sets of screenshots with different viewports.

3. **Update the database** — add a `device` field to `Screenshot` and `VisualDiff` (or use a naming convention like `base-home-mobile.png`).

4. **Update the UI** to show desktop and mobile screenshots side by side.

## Add Email/Slack Notifications on Completion

In Phase 4 of the worker (`worker/index.ts`), after updating the DiffRun status:

```typescript
// After the DiffRun.update() call
if (summary.riskCount > 0) {
  await sendSlackNotification({
    text: `Diff complete with ${summary.riskCount} regressions: ${diffRun.baseThemeName} → ${diffRun.candidateThemeName}`,
    url: `${process.env.SHOPIFY_APP_URL}/app/diff/${diffRunId}`,
  });
}
```

## Clean Up Old Runs

Currently, old screenshots accumulate in `public/runs/`. To auto-clean:

1. **Add a scheduled job** (or cron) that runs periodically
2. Query for DiffRuns older than N days
3. Delete the `public/runs/{id}/` directories
4. Delete the DiffRun records

Or add a "Delete runs older than X" button in the UI.

## Key Files Quick Reference

| What You Want to Change | File(s) |
|---|---|
| Screenshot settings (viewport, timing) | `worker/screenshots.ts` |
| Which pages get screenshotted | `worker/pageTargets.ts` |
| Diff sensitivity/accuracy | `worker/visualDiff.ts` |
| DOM checks | `worker/checks.ts` + `worker/types.ts` |
| User-facing settings | `prisma/schema.prisma` + `app/routes/app.settings.tsx` |
| Results display | `app/routes/app.diff.$diffRunId.tsx` |
| Job queue behavior | `app/lib/queue.server.ts` + `worker/index.ts` |
| API rate limiting | `worker/shopifyFetch.ts` |
| File storage | `worker/storage.ts` |
| Toast notifications | `app/components/Notification.tsx` |

## Development Workflow

1. **Start infrastructure:** `docker compose up -d` (Postgres + Redis)
2. **Start the web app:** `npm run dev` (or `shopify app dev`)
3. **Start the worker:** `npm run worker` (in a separate terminal)
4. **Watch worker logs:** The worker prints detailed progress to stdout
5. **Inspect the database:** `npm run prisma:studio` opens a web UI for the DB
6. **After schema changes:** `npx prisma db push && npx prisma generate`, then restart both processes
