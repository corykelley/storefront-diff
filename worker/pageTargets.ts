import { shopifyFetch } from "./shopifyFetch.js";
import type { PipelineContext, PageTargetDef } from "./types.js";

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

export async function resolvePageTargets(
  ctx: PipelineContext,
  customUrls?: string | null,
): Promise<PageTargetDef[]> {
  const targets: PageTargetDef[] = [
    { pageType: "home", path: "/" },
    { pageType: "cart", path: "/cart" },
  ];

  // Try to resolve a product handle
  try {
    const data = await shopifyFetch<{
      products: Array<{ handle: string }>;
    }>(ctx.shopDomain, ctx.accessToken, "products.json?status=active&limit=1");

    if (data.products.length > 0) {
      const handle = data.products[0].handle;
      targets.push({
        pageType: "product",
        path: `/products/${handle}`,
        handle,
      });
    }
  } catch (err) {
    console.warn(
      "[worker] Failed to resolve product target:",
      (err as Error).message,
    );
  }

  // Try to resolve a collection handle
  try {
    let handle: string | null = null;

    const customData = await shopifyFetch<{
      custom_collections: Array<{ handle: string }>;
    }>(ctx.shopDomain, ctx.accessToken, "custom_collections.json?limit=1");

    if (customData.custom_collections.length > 0) {
      handle = customData.custom_collections[0].handle;
    } else {
      const smartData = await shopifyFetch<{
        smart_collections: Array<{ handle: string }>;
      }>(ctx.shopDomain, ctx.accessToken, "smart_collections.json?limit=1");

      if (smartData.smart_collections.length > 0) {
        handle = smartData.smart_collections[0].handle;
      }
    }

    if (handle) {
      targets.push({
        pageType: "collection",
        path: `/collections/${handle}`,
        handle,
      });
    }
  } catch (err) {
    console.warn(
      "[worker] Failed to resolve collection target:",
      (err as Error).message,
    );
  }

  // Append custom URLs
  const custom = parseCustomUrls(customUrls);
  targets.push(...custom);

  return targets;
}

export function buildPreviewUrl(
  shopDomain: string,
  themeId: bigint,
  path: string,
): string {
  const url = new URL(`https://${shopDomain}${path}`);
  url.searchParams.set("preview_theme_id", themeId.toString());
  return url.toString();
}

export async function createPageTargetRecords(
  ctx: PipelineContext,
  targets: PageTargetDef[],
): Promise<string[]> {
  const ids: string[] = [];

  for (const t of targets) {
    const record = await ctx.prisma.pageTarget.create({
      data: {
        diffRunId: ctx.diffRunId,
        pageType: t.pageType,
        path: t.path,
        handle: t.handle ?? null,
      },
    });
    ids.push(record.id);
  }

  return ids;
}
