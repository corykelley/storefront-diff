/**
 * BullMQ Worker — runs as a separate process.
 *
 * Processes theme-diff jobs:
 *   1. Read DiffRun from DB
 *   2. Get shop access token from Session table
 *   3. List assets for both themes
 *   4. Categorize added / removed / common
 *   5. For common text assets: fetch content, hash, diff if modified
 *   6. Store AssetDiff rows
 *   7. Update DiffRun status + summary
 */

import { Worker, Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";

// ── Config ───────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const API_VERSION = "2024-10";
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const MAX_ASSET_SIZE = 500 * 1024; // 500 KB
const THROTTLE_MS = 550; // ~2 requests/sec to stay under Shopify REST rate limit

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".webm", ".pdf", ".mp3", ".ogg", ".zip", ".gz",
]);

// ── Prisma client ────────────────────────────────────────────────────

const prisma = new PrismaClient();

// ── Redis connection config ──────────────────────────────────────────

const connectionConfig = { url: REDIS_URL };

// ── Helpers ──────────────────────────────────────────────────────────

function isBinary(key: string): boolean {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(key.slice(dot).toLowerCase());
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number): number {
  const base = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  return base + Math.random() * base * 0.3;
}

// ── Shopify REST fetcher with 429 retry ──────────────────────────────

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
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : backoff(attempt);
      console.warn(
        `[worker] 429 on ${path} — retry in ${Math.round(waitMs)}ms (${attempt + 1}/${MAX_RETRIES})`
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

  throw new Error("Exhausted retries");
}

// ── Types ────────────────────────────────────────────────────────────

interface AssetListItem {
  key: string;
  content_type: string;
  size: number;
}

interface AssetDetail {
  key: string;
  value?: string;
  attachment?: string;
}

// ── Core diff logic ──────────────────────────────────────────────────

async function processDiffJob(job: Job<{ diffRunId: string }>) {
  const { diffRunId } = job.data;
  console.log(`[worker] Processing diff job: ${diffRunId}`);

  // 1. Load DiffRun
  const diffRun = await prisma.diffRun.findUnique({ where: { id: diffRunId } });
  if (!diffRun) {
    throw new Error(`DiffRun ${diffRunId} not found`);
  }

  // 2. Get access token from Shop table (populated by afterAuth hook)
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: diffRun.shopDomain },
  });
  if (!shop) {
    throw new Error(`Shop ${diffRun.shopDomain} not found — has the app been installed?`);
  }
  const accessToken = shop.accessToken;

  // Mark as running
  await prisma.diffRun.update({
    where: { id: diffRunId },
    data: { status: "running" },
  });

  try {
    // 3. List assets for both themes
    const [baseAssets, candidateAssets] = await Promise.all([
      shopifyFetch<{ assets: AssetListItem[] }>(
        diffRun.shopDomain,
        accessToken,
        `themes/${diffRun.baseThemeId}/assets.json`
      ).then((r) => r.assets),
      shopifyFetch<{ assets: AssetListItem[] }>(
        diffRun.shopDomain,
        accessToken,
        `themes/${diffRun.candidateThemeId}/assets.json`
      ).then((r) => r.assets),
    ]);

    const baseKeySet = new Set(baseAssets.map((a) => a.key));
    const candidateKeySet = new Set(candidateAssets.map((a) => a.key));

    // 4. Categorize
    const added: string[] = [];
    const removed: string[] = [];
    const common: string[] = [];

    for (const key of candidateKeySet) {
      if (!baseKeySet.has(key)) added.push(key);
    }
    for (const key of baseKeySet) {
      if (!candidateKeySet.has(key)) removed.push(key);
      else common.push(key);
    }

    // 5. Prepare AssetDiff rows to insert
    const diffRows: Array<{
      diffRunId: string;
      key: string;
      changeType: string;
      diffText: string | null;
    }> = [];

    // Added
    for (const key of added) {
      diffRows.push({ diffRunId, key, changeType: "added", diffText: null });
    }

    // Removed
    for (const key of removed) {
      diffRows.push({ diffRunId, key, changeType: "removed", diffText: null });
    }

    // Common — need to compare content
    let modifiedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < common.length; i++) {
      const key = common[i];

      // Skip binary assets
      if (isBinary(key)) {
        diffRows.push({
          diffRunId,
          key,
          changeType: "binary-skipped",
          diffText: null,
        });
        skippedCount++;
        continue;
      }

      // Fetch content SEQUENTIALLY with throttle to avoid 429s
      let baseAsset: AssetDetail;
      let candidateAsset: AssetDetail;

      try {
        baseAsset = await shopifyFetch<{ asset: AssetDetail }>(
          diffRun.shopDomain,
          accessToken,
          `themes/${diffRun.baseThemeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
        ).then((r) => r.asset);

        await sleep(THROTTLE_MS);

        candidateAsset = await shopifyFetch<{ asset: AssetDetail }>(
          diffRun.shopDomain,
          accessToken,
          `themes/${diffRun.candidateThemeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
        ).then((r) => r.asset);

        await sleep(THROTTLE_MS);
      } catch (err) {
        console.error(`[worker] Failed to fetch asset ${key}:`, (err as Error).message);
        diffRows.push({
          diffRunId,
          key,
          changeType: "large-file-skipped",
          diffText: `Error fetching: ${(err as Error).message}`,
        });
        skippedCount++;
        continue;
      }

      if (i % 10 === 0) {
        console.log(`[worker] Progress: ${i}/${common.length} common assets compared`);
      }

      const baseContent = baseAsset.value ?? "";
      const candidateContent = candidateAsset.value ?? "";

      // Check size
      if (
        Buffer.byteLength(baseContent, "utf-8") > MAX_ASSET_SIZE ||
        Buffer.byteLength(candidateContent, "utf-8") > MAX_ASSET_SIZE
      ) {
        diffRows.push({
          diffRunId,
          key,
          changeType: "large-file-skipped",
          diffText: null,
        });
        skippedCount++;
        continue;
      }

      // Hash compare
      const baseHash = sha256(baseContent);
      const candidateHash = sha256(candidateContent);

      if (baseHash === candidateHash) {
        // Identical — skip (no row needed)
        continue;
      }

      // Compute unified diff
      const patch = createTwoFilesPatch(
        `base/${key}`,
        `candidate/${key}`,
        baseContent,
        candidateContent,
        undefined,
        undefined,
        { context: 3 }
      );

      diffRows.push({
        diffRunId,
        key,
        changeType: "modified",
        diffText: patch,
      });
      modifiedCount++;
    }

    // 6. Bulk insert AssetDiff rows
    if (diffRows.length > 0) {
      await prisma.assetDiff.createMany({ data: diffRows });
    }

    // 7. Update DiffRun — complete
    const summary = {
      added: added.length,
      removed: removed.length,
      modified: modifiedCount,
      skipped: skippedCount,
    };

    await prisma.diffRun.update({
      where: { id: diffRunId },
      data: {
        status: "complete",
        summary,
      },
    });

    console.log(
      `[worker] Diff complete: ${diffRunId} — ` +
        `added=${summary.added}, removed=${summary.removed}, ` +
        `modified=${summary.modified}, skipped=${summary.skipped}`
    );

    /*
     * TODO: Visual Diff Placeholder
     * ─────────────────────────────
     * Future enhancement steps:
     *
     * 1. After text diffs are complete, optionally trigger a visual diff job.
     * 2. Use Puppeteer or Playwright to open both theme preview URLs:
     *    - Base: https://{shop}/?preview_theme_id={baseThemeId}
     *    - Candidate: https://{shop}/?preview_theme_id={candidateThemeId}
     * 3. Navigate to key pages (homepage, product page, collection page).
     * 4. Capture full-page screenshots.
     * 5. Upload to S3 / CloudFlare R2.
     * 6. Run pixel-diff (e.g. pixelmatch) to generate diff overlay images.
     * 7. Store visual diff metadata in a new VisualDiff model.
     * 8. Notify the UI via the DiffRun record (add a `visualDiffStatus` field).
     */
  } catch (err) {
    console.error(`[worker] Diff failed: ${diffRunId}`, (err as Error).message);
    await prisma.diffRun.update({
      where: { id: diffRunId },
      data: {
        status: "failed",
        errorMessage: (err as Error).message.slice(0, 500),
      },
    });
    throw err; // Let BullMQ handle retry
  }
}

// ── Start worker ─────────────────────────────────────────────────────

const worker = new Worker("theme-diff", processDiffJob, {
  connection: connectionConfig,
  concurrency: 1,
  lockDuration: 300_000, // 5 min — asset comparison can take a while
});

worker.on("completed", (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("[worker] Worker error:", err.message);
});

console.log("[worker] ThemeDiff worker started, waiting for jobs...");

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[worker] Shutting down...");
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[worker] Shutting down...");
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});
