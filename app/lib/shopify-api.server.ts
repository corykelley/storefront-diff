/**
 * Shopify Admin REST API client with rate-limit handling.
 *
 * Uses native fetch. Never logs access tokens.
 */

const API_VERSION = "2024-10";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_ASSET_SIZE = 500 * 1024; // 500 KB

// Extensions considered binary (skip content fetch entirely)
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp4",
  ".webm",
  ".pdf",
  ".mp3",
  ".ogg",
  ".zip",
  ".gz",
]);

// ── helpers ──────────────────────────────────────────────────────────

export function isBinaryAssetKey(key: string): boolean {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(key.slice(dot).toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Add jitter so retries don't thundering-herd. */
function backoff(attempt: number): number {
  const base = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.3;
  return base + jitter;
}

// ── Core fetcher with 429 retry ──────────────────────────────────────

async function shopifyFetch<T>(
  shop: string,
  accessToken: string,
  path: string
): Promise<T> {
  const url = `https://${shop}/admin/api/${API_VERSION}/${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Rate limited after ${MAX_RETRIES} retries: ${path}`);
      }
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : backoff(attempt);
      console.warn(
        `[shopify-api] 429 on ${path} — retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Shopify API ${res.status} on ${path}: ${body.slice(0, 300)}`
      );
    }

    return (await res.json()) as T;
  }

  // Unreachable but satisfies TS
  throw new Error("Exhausted retries");
}

// ── Public API ───────────────────────────────────────────────────────

export interface ShopifyTheme {
  id: number;
  name: string;
  role: string;
  created_at: string;
  updated_at: string;
  previewable: boolean;
  processing: boolean;
}

export interface ShopifyAssetKey {
  key: string;
  public_url: string | null;
  content_type: string;
  size: number;
  created_at: string;
  updated_at: string;
  checksum: string | null;
  theme_id: number;
}

export interface ShopifyAsset {
  key: string;
  value?: string; // text content (absent for binary)
  attachment?: string; // base64 for binary
  public_url: string | null;
  content_type: string;
  size: number;
}

/** List all themes for a shop. */
export async function listThemes(
  shop: string,
  accessToken: string
): Promise<ShopifyTheme[]> {
  const data = await shopifyFetch<{ themes: ShopifyTheme[] }>(
    shop,
    accessToken,
    "themes.json"
  );
  return data.themes;
}

/** List all asset keys for a theme. */
export async function listAssets(
  shop: string,
  accessToken: string,
  themeId: number
): Promise<ShopifyAssetKey[]> {
  const data = await shopifyFetch<{ assets: ShopifyAssetKey[] }>(
    shop,
    accessToken,
    `themes/${themeId}/assets.json`
  );
  return data.assets;
}

/** Fetch a single asset's content. */
export async function getAsset(
  shop: string,
  accessToken: string,
  themeId: number,
  key: string
): Promise<ShopifyAsset> {
  const data = await shopifyFetch<{ asset: ShopifyAsset }>(
    shop,
    accessToken,
    `themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
  );
  return data.asset;
}

/** Check if an asset value exceeds the size limit. */
export function isAssetTooLarge(value: string): boolean {
  return Buffer.byteLength(value, "utf-8") > MAX_ASSET_SIZE;
}
