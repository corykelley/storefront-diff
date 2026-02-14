# Screenshot Capture & Page Targets

## Page Target Resolution

**File:** `worker/pageTargets.ts`

Before taking screenshots, the worker figures out which pages to capture. This happens in `resolvePageTargets()`.

### Auto-Discovered Pages

Every diff run includes these by default:

| Page Type | Path | How It's Resolved |
|---|---|---|
| `home` | `/` | Hardcoded |
| `cart` | `/cart` | Hardcoded |
| `product` | `/products/{handle}` | Fetches first active product via `products.json?status=active&limit=1` |
| `collection` | `/collections/{handle}` | Fetches first custom collection, falls back to first smart collection |

Product and collection resolution use the Shopify Admin REST API. If the API calls fail (e.g., no products exist), the pipeline logs a warning and continues without that page type.

### Custom Pages

Users can add custom page paths in Settings (one per line):

```
/pages/about
/blogs/news
/pages/contact
```

These are parsed by `parseCustomUrls()`:

```typescript
export function parseCustomUrls(customUrls: string | null | undefined): PageTargetDef[] {
  if (!customUrls) return [];
  return customUrls
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith("/"))
    .map((path) => ({
      pageType: "custom-" + path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-$/, ""),
      path,
    }));
}
```

**Validation:**
- Lines are trimmed and empty lines are skipped
- Must start with `/` (relative paths only)

**Page type naming:** The path is slugified into the `pageType` to prevent filename collisions. `/pages/about` becomes `custom-pages-about`. This matters because screenshots are saved as `base-{pageType}.png`.

### Preview URLs

Each page is viewed through Shopify's theme preview system:

```typescript
export function buildPreviewUrl(shopDomain: string, themeId: bigint, path: string): string {
  const url = new URL(`https://${shopDomain}${path}`);
  url.searchParams.set("preview_theme_id", themeId.toString());
  return url.toString();
}
```

Example: `https://my-store.myshopify.com/products/t-shirt?preview_theme_id=123456789`

This lets you see what any page looks like on a specific theme, even if that theme isn't published. The base and candidate themes are viewed through different `preview_theme_id` values.

## Screenshot Capture

**File:** `worker/screenshots.ts`

### Browser Management

Playwright launches a single Chromium instance that's reused across all screenshots:

```typescript
let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}
```

Each screenshot gets its own **browser context** (isolated cookie jar, viewport settings):

```typescript
const context = await b.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
```

**Viewport:** 1440x900 is a standard desktop resolution. Screenshots are full-page (not clipped to viewport), so the actual image height varies by page content.

### Capture Flow

Here's what `captureScreenshot()` does, step by step:

#### 1. Navigate

```typescript
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
```

`networkidle` means Playwright waits until there are no more than 2 network connections for 500ms. This ensures the page is "done loading" (images, fonts, API calls, etc.).

Timeout is 60 seconds — some Shopify stores are slow.

#### 2. Handle Password Protection

```typescript
if (storefrontPassword) {
  const passwordInput = await page.$('form input[type="password"]');
  if (passwordInput) {
    await passwordInput.fill(storefrontPassword);
    const submitBtn = await page.$('form button[type="submit"], form input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
    }
    // Password page redirects to "/" — re-navigate to intended URL
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  }
}
```

If the store is password-protected (common for dev stores), the first navigation lands on the password page. The code:
1. Detects the password form
2. Fills and submits it
3. Waits for redirect
4. Re-navigates to the original URL (because the password submit redirects to `/`)

**Note:** If the store isn't password-protected, the password input won't be found and this block is skipped entirely.

#### 3. Inject CSS

```typescript
// Freeze animations
await page.addStyleTag({
  content: FREEZE_CSS + "\n" + SHOPIFY_HIDE_CSS
});
```

Two CSS injections happen regardless of user settings:

**Freeze CSS:**
```css
*, *::before, *::after {
  animation-duration: 0s !important;
  transition-duration: 0s !important;
}
```
Without this, animated elements (carousels, fade-ins, blinking cursors) would produce different screenshots each time.

**Shopify Preview Bar CSS:**
```css
#preview-bar-iframe, #shopify-preview-bar, iframe[src*="preview-bar"] {
  display: none !important;
  height: 0 !important;
}
```
The preview bar is Shopify infrastructure that appears on preview URLs. It's not part of the theme, so it shouldn't appear in diffs.

#### 4. Hide User-Specified Selectors

```typescript
if (hideSelectors) {
  const selectors = hideSelectors.split("\n").map(s => s.trim()).filter(Boolean);
  if (selectors.length > 0) {
    const css = selectors.map(s => `${s} { visibility: hidden !important; }`).join("\n");
    await page.addStyleTag({ content: css });
  }
}
```

User-configured selectors use `visibility: hidden` (not `display: none`) to preserve layout. If a chat widget is hidden, the space it occupied stays empty rather than collapsing and shifting everything else.

#### 5. Wait for DOM to Settle

```typescript
await page.waitForTimeout(1500);
```

A 1.5-second pause for any remaining JavaScript to execute, lazy images to load, etc. This is a pragmatic choice — some Shopify themes have JavaScript that runs after `networkidle`.

#### 6. Take Screenshot

```typescript
const screenshotBuffer = await page.screenshot({ fullPage: true });
```

`fullPage: true` captures the entire scrollable page, not just the viewport. A page that's 5000px tall produces a 1440x5000 screenshot.

#### 7. Get Dimensions

```typescript
const dimensions = await page.evaluate(() => ({
  width: document.documentElement.scrollWidth,
  height: document.documentElement.scrollHeight,
}));
```

These dimensions are stored in the Screenshot record for reference.

#### 8. Save to Storage

```typescript
await storage.write(outputPath, Buffer.from(screenshotBuffer));
```

The `StorageProvider` writes to `public/runs/{runId}/base-{pageType}.png`.

### The Wrapper: `capturePageTargetScreenshots()`

This is what the pipeline actually calls. It wraps `captureScreenshot()` and also:
1. Saves a Screenshot record to the database
2. Returns the `page` and `context` objects (so DOM checks can run on the same page)

```typescript
export async function capturePageTargetScreenshots(
  ctx, pageTargetId, variant, url, pageType,
  storefrontPassword, hideSelectors, storage,
): Promise<{ page: Page; context: BrowserContext }>
```

The caller is responsible for closing the context after running checks:
```typescript
const baseResult = await capturePageTargetScreenshots(...);
const baseChecks = await runChecksOnPage(baseResult.page, targetDef.pageType);
await baseResult.context.close();  // must close!
```

## Storage System

**File:** `worker/storage.ts`

Screenshots and diff images are saved through a `StorageProvider` interface:

```typescript
interface StorageProvider {
  write(relativePath: string, data: Buffer): Promise<void>;
  publicUrl(relativePath: string): string;
}
```

### LocalStorageProvider (default)

Writes to `./public/{relativePath}`. Creates directories automatically. Files are served by Remix's static file handler at `/{relativePath}`.

Example: `write("runs/abc123/base-home.png", buffer)` → file at `./public/runs/abc123/base-home.png` → served at `/runs/abc123/base-home.png`.

### S3StorageProvider (stub)

Not implemented. Placeholder for future cloud storage support.

## File Naming Convention

All files for a single diff run live in `public/runs/{diffRunId}/`:

```
runs/
  cml123abc/
    base-home.png         # Base theme, home page
    candidate-home.png    # Candidate theme, home page
    diff-home.png         # Visual diff, home page
    base-product.png
    candidate-product.png
    diff-product.png
    base-cart.png
    candidate-cart.png
    diff-cart.png
    base-custom-pages-about.png    # Custom URL
    candidate-custom-pages-about.png
    diff-custom-pages-about.png
```

The `pageType` string determines the filename. This is why custom URLs get slugified page types — to prevent path separators or special characters in filenames.
