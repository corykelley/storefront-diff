# Shopify Integration

This doc covers how the app authenticates with Shopify, calls the Admin API, and handles the embedded app lifecycle.

## Authentication

### How Shopify Embedded Auth Works

StoreFront Diff runs inside Shopify Admin as an embedded app (in an iframe). The authentication flow:

1. Merchant installs the app → Shopify redirects to the app with OAuth params
2. `@shopify/shopify-app-remix` handles the OAuth handshake
3. After auth, the app receives a **session** with `shop` domain and `accessToken`
4. Subsequent requests from the iframe include a signed JWT that the library verifies

**File:** `app/shopify.server.ts`

```typescript
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: LATEST,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // ...
});
```

### The `afterAuth` Hook

```typescript
hooks: {
  afterAuth: async ({ session }) => {
    shopify.registerWebhooks({ session });
    // Persist shop + token for the worker
    await prisma.shop.upsert({
      where: { shopDomain: session.shop },
      create: { shopDomain: session.shop, accessToken: session.accessToken! },
      update: { accessToken: session.accessToken! },
    });
  },
},
```

This runs every time a merchant authenticates (initial install or re-auth). It:
1. Registers webhooks (APP_UNINSTALLED, GDPR events)
2. Saves the access token to the `Shop` table

**Why?** The worker process can't use Shopify's session middleware. It needs a direct way to look up `accessToken` by `shopDomain`. The `Shop` table serves as that bridge.

### Using Authentication in Routes

Every route that needs Shopify data starts with:

```typescript
const { session } = await authenticate.admin(request);
const shopDomain = session.shop;       // "my-store.myshopify.com"
const accessToken = session.accessToken; // "shpat_..."
```

If auth fails, the library automatically redirects through the OAuth flow.

### Auth Edge Cases

**`_index.tsx` (root route):** Must authenticate _before_ redirecting to `/app`. The Shopify CLI proxy drops query parameters during redirects, so the OAuth params would be lost.

**`auth.exit-iframe.tsx`:** Must NOT authenticate. This route breaks out of the iframe for OAuth. If it authenticated, it would redirect to itself in a loop.

## API Scopes

Defined in `shopify.app.toml`:

```toml
scopes = "read_themes,read_products"
```

| Scope | Used For |
|---|---|
| `read_themes` | List themes, fetch asset lists, fetch asset content |
| `read_products` | Fetch first product handle (for product page screenshots) |

**Note:** The app only reads — it never writes to themes or products. Collection data is accessed through the themes scope (via `custom_collections.json` and `smart_collections.json`).

## Shopify REST API Calls

### Web Process (`app/lib/shopify-api.server.ts`)

Used for the theme picker dropdown:

```typescript
export async function listThemes(shop: string, accessToken: string): Promise<ShopifyTheme[]>
```

Calls: `GET /admin/api/2024-10/themes.json`

### Worker Process (`worker/shopifyFetch.ts`)

Used for asset diffs and page target resolution:

```typescript
export async function shopifyFetch<T>(shop: string, accessToken: string, path: string): Promise<T>
```

Calls various endpoints:
- `themes/{id}/assets.json` — List all assets in a theme
- `themes/{id}/assets.json?asset[key]={key}` — Fetch a single asset's content
- `products.json?status=active&limit=1` — First active product
- `custom_collections.json?limit=1` — First custom collection
- `smart_collections.json?limit=1` — First smart collection

### Two API Clients

The app has **two separate Shopify API clients** — one in the web process and one in the worker. They're similar but have different retry configurations:

| Setting | Web Client | Worker Client |
|---|---|---|
| Max retries | 3 | 5 |
| Initial backoff | 1000ms | 2000ms |
| Backoff strategy | Exponential with jitter | Exponential with jitter |

The worker is more patient because it runs in the background and doesn't block user interactions.

## Rate Limiting

Shopify's REST API has a **bucket-based rate limit** (~40 requests per app per store, refills at 2/second).

### How Rate Limits Work

When you exceed the limit, Shopify returns a `429 Too Many Requests` response with a `Retry-After` header indicating how many seconds to wait.

### How We Handle It

Both API clients implement retry with exponential backoff:

```typescript
// Worker version (shopifyFetch.ts)
export function backoff(attempt: number): number {
  const base = 2000 * Math.pow(2, attempt);
  const jitter = base * 0.3 * (Math.random() * 2 - 1); // ±30%
  return base + jitter;
}
```

If the response includes `Retry-After`, we use that instead of the calculated backoff.

### Throttling

The worker adds a deliberate delay between API calls:

```typescript
const THROTTLE_MS = 550; // ~2 requests/sec
```

This keeps us well under the 2 req/sec refill rate, preventing 429s in most cases. The throttle is applied between consecutive asset fetches in Phase 1:

```typescript
baseAsset = await shopifyFetch(...);
await sleep(THROTTLE_MS);
candidateAsset = await shopifyFetch(...);
await sleep(THROTTLE_MS);
```

## Webhooks

**File:** `app/routes/webhooks.tsx`

Registered webhooks:

| Topic | Handler |
|---|---|
| `APP_UNINSTALLED` | Delete sessions + shop record |
| `CUSTOMERS_DATA_REQUEST` | No-op (no customer data stored) |
| `CUSTOMERS_REDACT` | No-op |
| `SHOP_REDACT` | No-op |

Webhook payloads are verified using `authenticate.webhook(request)`, which checks the HMAC signature to ensure the webhook came from Shopify.

**APP_UNINSTALLED** cleanup:
```typescript
await prisma.session.deleteMany({ where: { shop } });
await prisma.shop.deleteMany({ where: { shopDomain: shop } });
```

**Note:** This doesn't clean up DiffRun records or screenshot files. If you want full cleanup on uninstall, you'd add that here.

## Theme Preview URLs

The visual diff system uses Shopify's theme preview feature:

```
https://my-store.myshopify.com/products/t-shirt?preview_theme_id=123456789
```

The `preview_theme_id` query parameter tells Shopify to render the page using a specific theme, even if that theme isn't published. This is how we screenshot the same page on two different themes.

**Side effect:** This triggers Shopify's preview bar (a toolbar at the top of the page). That's why we inject CSS to hide it — the preview bar is not theme content and would cause false diffs.

## Configuration Files

### `shopify.app.toml`

```toml
name = "ThemeDiff"
client_id = "4b629de297f9e67fa0c6c0567dbe209c"
application_url = "https://..."
embedded = true

[access_scopes]
scopes = "read_themes,read_products"

[auth]
redirect_urls = [
  "https://..../auth/callback",
  "https://..../auth/shopify/callback",
  "https://..../api/auth/callback"
]

[webhooks]
api_version = "2024-10"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks"
```

### `shopify.web.toml`

```toml
[commands]
dev = "npx prisma generate && remix vite:dev"
build = "npx prisma generate && remix vite:build"

[[webhooks]]
http_path = "/webhooks"
```

**Note:** The dev/build commands run `prisma generate` first to ensure the Prisma client is up to date before the app starts.
