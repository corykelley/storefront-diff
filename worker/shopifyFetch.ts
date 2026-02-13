const API_VERSION = "2024-10";
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function backoff(attempt: number): number {
  const base = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  return base + Math.random() * base * 0.3;
}

export async function shopifyFetch<T>(
  shop: string,
  accessToken: string,
  path: string,
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
        `[worker] 429 on ${path} — retry in ${Math.round(waitMs)}ms (${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Shopify API ${res.status} on ${path}: ${body.slice(0, 300)}`,
      );
    }

    return (await res.json()) as T;
  }

  throw new Error("Exhausted retries");
}
