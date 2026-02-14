# Database Schema & Data Model

**File:** `prisma/schema.prisma`
**Database:** PostgreSQL 16 (local via Docker, `docker-compose.yml`)
**ORM:** Prisma Client v5.22

## Entity Relationship Diagram

```
Session (Shopify-managed)
    shop ─────────┐
                   │
Shop               │
    shopDomain ────┤
    accessToken    │
                   │
ShopSetting        │
    shopDomain ────┘
    storefrontPassword
    hideSelectors
    customUrls

DiffRun
    shopDomain
    baseThemeId / candidateThemeId
    status (queued → running → complete | failed)
    summary (JSON)
    │
    ├── AssetDiff[]        (1-to-many)
    │     key, changeType, diffText
    │
    └── PageTarget[]       (1-to-many, cascade delete)
          pageType, path
          │
          ├── Screenshot[]   (1-to-many, cascade delete)
          │     variant (base|candidate), filePath, width, height
          │
          ├── VisualDiff     (1-to-1, cascade delete)
          │     diffFilePath, mismatchPercent, mismatchCount
          │
          └── CheckResult[]  (1-to-many, cascade delete)
                checkName, variant, passed, selector
```

## Models in Detail

### Session

```prisma
model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
}
```

**You don't manage this directly.** It's owned by `@shopify/shopify-app-session-storage-prisma`. Shopify's auth library reads and writes session data here during OAuth and API calls.

The `accessToken` in Session is the same one stored in `Shop.accessToken` — the `afterAuth` hook in `shopify.server.ts` copies it to the `Shop` table so the worker process can access it without needing session context.

### Shop

```prisma
model Shop {
  id          String   @id @default(cuid())
  shopDomain  String   @unique
  accessToken String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**Why does this exist when Session already has the access token?**

The worker process runs separately and doesn't go through Shopify's session middleware. It needs a simple way to look up `accessToken` by `shopDomain`. The `afterAuth` hook in `shopify.server.ts` upserts this row every time the merchant re-authenticates.

**Used by:** `worker/index.ts` (line ~211) — looks up the shop to get the access token before starting the pipeline.

### ShopSetting

```prisma
model ShopSetting {
  id                 String   @id @default(cuid())
  shopDomain         String   @unique
  storefrontPassword String?
  hideSelectors      String?  @db.Text
  customUrls         String?  @db.Text
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

Per-shop configuration managed by the Settings page (`app/routes/app.settings.tsx`).

| Field | Format | Purpose |
|---|---|---|
| `storefrontPassword` | Plain string | If the store is password-protected (dev stores), this password is filled into the password form before screenshots |
| `hideSelectors` | Newline-separated CSS selectors | Elements to hide during screenshots (chat widgets, cookie banners, etc.) |
| `customUrls` | Newline-separated URL paths | Additional pages to screenshot beyond auto-discovered ones (e.g., `/pages/about`) |

**Used by:** `worker/index.ts` — loaded before Phase 2 (page targets) and Phase 3 (screenshots).

### DiffRun

```prisma
model DiffRun {
  id                 String      @id @default(cuid())
  shopDomain         String
  baseThemeId        BigInt
  baseThemeName      String
  candidateThemeId   BigInt
  candidateThemeName String
  status             String      @default("queued")
  summary            Json?
  errorMessage       String?
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt
  assetDiffs         AssetDiff[]
  pageTargets        PageTarget[]
}
```

The root record for a diff comparison. Created by the web app when the user clicks "Run Diff", updated by the worker as it progresses.

**Status lifecycle:** `queued` → `running` → `complete` | `failed`

**Summary JSON shape** (written in Phase 4):
```json
{
  "added": 3,
  "removed": 1,
  "modified": 12,
  "skipped": 5,
  "pageTargets": 4,
  "screenshotsComplete": 4,
  "screenshotsFailed": 0,
  "maxMismatchPercent": 23.45,
  "riskCount": 1,
  "regressions": [
    { "checkName": "PDP_ATC_PRESENT", "pageType": "product" }
  ]
}
```

**Theme IDs are BigInt** because Shopify theme IDs are large integers. The results viewer converts them to strings for JSON serialization (BigInt can't be serialized to JSON natively).

### AssetDiff

```prisma
model AssetDiff {
  id         String   @id @default(cuid())
  diffRunId  String
  diffRun    DiffRun  @relation(...)
  key        String        // "templates/index.liquid"
  changeType String        // added | removed | modified | large-file-skipped | binary-skipped
  diffText   String?  @db.Text
  createdAt  DateTime @default(now())
  @@index([diffRunId])
}
```

One row per file that differs between themes. `diffText` contains a unified diff patch (only for `modified` files). Binary files and large files are recorded but without diff content.

**Created by:** `worker/index.ts` → `runAssetDiffs()` (Phase 1).

### PageTarget

```prisma
model PageTarget {
  id           String        @id @default(cuid())
  diffRunId    String
  diffRun      DiffRun       @relation(...)
  pageType     String        // "home" | "product" | "collection" | "cart" | "custom-*"
  path         String        // "/" | "/products/some-handle" | "/pages/about"
  handle       String?       // product/collection handle (null for home, cart, custom)
  status       String        @default("pending")
  errorMessage String?
  createdAt    DateTime      @default(now())
  screenshots  Screenshot[]
  visualDiffs  VisualDiff[]
  checkResults CheckResult[]
  @@index([diffRunId])
}
```

Represents one page to compare. Each PageTarget gets two screenshots (base + candidate), one visual diff, and zero or more check results.

**Status lifecycle:** `pending` → `complete` | `failed`

Custom URL targets have a `pageType` like `custom-pages-about` (derived from the path). This ensures unique file names for screenshots.

### Screenshot

```prisma
model Screenshot {
  id           String     @id @default(cuid())
  pageTargetId String
  pageTarget   PageTarget @relation(...)
  variant      String     // "base" | "candidate"
  filePath     String     // "runs/{runId}/base-home.png"
  width        Int
  height       Int
  createdAt    DateTime   @default(now())
  @@index([pageTargetId])
}
```

Metadata for a captured screenshot. The actual PNG file lives at `public/{filePath}`. Each PageTarget should have exactly two screenshots (base and candidate).

### VisualDiff

```prisma
model VisualDiff {
  id              String     @id @default(cuid())
  pageTargetId    String     @unique     // one diff per target
  pageTarget      PageTarget @relation(...)
  diffFilePath    String                 // "runs/{runId}/diff-home.png"
  mismatchCount   Int                    // raw pixel count
  mismatchPercent Float                  // 0.0–100.0
  totalPixels     Int                    // full canvas pixel count
  effectivePixels Int        @default(0) // denominator used for %
  createdAt       DateTime   @default(now())
}
```

The pixel comparison result. `pageTargetId` is unique — one diff per page target. The diff image (`diffFilePath`) highlights mismatched pixels in red/magenta.

### CheckResult

```prisma
model CheckResult {
  id           String     @id @default(cuid())
  pageTargetId String
  pageTarget   PageTarget @relation(...)
  checkName    String     // "PDP_ATC_PRESENT", etc.
  variant      String     // "base" | "candidate"
  passed       Boolean
  selector     String     // CSS selector used
  detail       String?    // "Element found" | "Element not found"
  createdAt    DateTime   @default(now())
  @@index([pageTargetId])
}
```

DOM check results. Each check runs on both variants, producing two rows per check per page target. A **regression** is when base passes but candidate fails.

## Cascade Deletes

When you delete a `DiffRun`, everything cascades:

```
DELETE DiffRun
  → DELETE AssetDiff[]
  → DELETE PageTarget[]
      → DELETE Screenshot[]
      → DELETE VisualDiff
      → DELETE CheckResult[]
```

The delete action in `app.diff._index.tsx` also removes the `public/runs/{id}/` directory from disk.

## Common Queries

**Load a full diff run with all data** (used by the results viewer):
```typescript
prisma.diffRun.findUnique({
  where: { id: diffRunId },
  include: {
    assetDiffs: { orderBy: { key: "asc" } },
    pageTargets: {
      include: {
        screenshots: true,
        visualDiffs: true,
        checkResults: true,
      },
    },
  },
});
```

**Upsert shop settings:**
```typescript
prisma.shopSetting.upsert({
  where: { shopDomain },
  create: { shopDomain, storefrontPassword, hideSelectors, customUrls },
  update: { storefrontPassword, hideSelectors, customUrls },
});
```

## Schema Changes

This project uses `prisma db push` (not migrations). To modify the schema:

1. Edit `prisma/schema.prisma`
2. Run `npx prisma db push` to sync
3. Run `npx prisma generate` to update the client
4. Restart both the web server and worker
