/**
 * BullMQ Worker — orchestrator process.
 *
 * Pipeline phases:
 *   1. Asset diffs (V1 logic)
 *   2. Page target resolution
 *   3. Per-target: screenshots → DOM checks → visual diff
 *   4. Finalize summary
 */

import { Worker, Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";

import { shopifyFetch, sleep } from "./shopifyFetch.js";
import { resolvePageTargets, buildPreviewUrl, createPageTargetRecords } from "./pageTargets.js";
import { capturePageTargetScreenshots, closeBrowser } from "./screenshots.js";
import { generateVisualDiff } from "./visualDiff.js";
import { runChecksOnPage, persistCheckResults } from "./checks.js";
import { createStorageProvider } from "./storage.js";
import type { PipelineContext } from "./types.js";

// ── Config ───────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
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

// ── Phase 1: Asset Diffs (extracted V1 logic) ────────────────────────

async function runAssetDiffs(
  ctx: PipelineContext,
): Promise<{ added: number; removed: number; modified: number; skipped: number }> {
  const [baseAssets, candidateAssets] = await Promise.all([
    shopifyFetch<{ assets: AssetListItem[] }>(
      ctx.shopDomain,
      ctx.accessToken,
      `themes/${ctx.baseThemeId}/assets.json`,
    ).then((r) => r.assets),
    shopifyFetch<{ assets: AssetListItem[] }>(
      ctx.shopDomain,
      ctx.accessToken,
      `themes/${ctx.candidateThemeId}/assets.json`,
    ).then((r) => r.assets),
  ]);

  const baseKeySet = new Set(baseAssets.map((a) => a.key));
  const candidateKeySet = new Set(candidateAssets.map((a) => a.key));

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

  const diffRows: Array<{
    diffRunId: string;
    key: string;
    changeType: string;
    diffText: string | null;
  }> = [];

  for (const key of added) {
    diffRows.push({ diffRunId: ctx.diffRunId, key, changeType: "added", diffText: null });
  }
  for (const key of removed) {
    diffRows.push({ diffRunId: ctx.diffRunId, key, changeType: "removed", diffText: null });
  }

  let modifiedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < common.length; i++) {
    const key = common[i];

    if (isBinary(key)) {
      diffRows.push({ diffRunId: ctx.diffRunId, key, changeType: "binary-skipped", diffText: null });
      skippedCount++;
      continue;
    }

    let baseAsset: AssetDetail;
    let candidateAsset: AssetDetail;

    try {
      baseAsset = await shopifyFetch<{ asset: AssetDetail }>(
        ctx.shopDomain,
        ctx.accessToken,
        `themes/${ctx.baseThemeId}/assets.json?asset[key]=${encodeURIComponent(key)}`,
      ).then((r) => r.asset);

      await sleep(THROTTLE_MS);

      candidateAsset = await shopifyFetch<{ asset: AssetDetail }>(
        ctx.shopDomain,
        ctx.accessToken,
        `themes/${ctx.candidateThemeId}/assets.json?asset[key]=${encodeURIComponent(key)}`,
      ).then((r) => r.asset);

      await sleep(THROTTLE_MS);
    } catch (err) {
      console.error(`[worker] Failed to fetch asset ${key}:`, (err as Error).message);
      diffRows.push({
        diffRunId: ctx.diffRunId,
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

    if (
      Buffer.byteLength(baseContent, "utf-8") > MAX_ASSET_SIZE ||
      Buffer.byteLength(candidateContent, "utf-8") > MAX_ASSET_SIZE
    ) {
      diffRows.push({ diffRunId: ctx.diffRunId, key, changeType: "large-file-skipped", diffText: null });
      skippedCount++;
      continue;
    }

    const baseHash = sha256(baseContent);
    const candidateHash = sha256(candidateContent);

    if (baseHash === candidateHash) continue;

    const patch = createTwoFilesPatch(
      `base/${key}`,
      `candidate/${key}`,
      baseContent,
      candidateContent,
      undefined,
      undefined,
      { context: 3 },
    );

    diffRows.push({ diffRunId: ctx.diffRunId, key, changeType: "modified", diffText: patch });
    modifiedCount++;
  }

  if (diffRows.length > 0) {
    await ctx.prisma.assetDiff.createMany({ data: diffRows });
  }

  return { added: added.length, removed: removed.length, modified: modifiedCount, skipped: skippedCount };
}

// ── Main job processor ───────────────────────────────────────────────

async function processDiffJob(job: Job<{ diffRunId: string }>) {
  const { diffRunId } = job.data;
  console.log(`[worker] Processing diff job: ${diffRunId}`);

  const diffRun = await prisma.diffRun.findUnique({ where: { id: diffRunId } });
  if (!diffRun) throw new Error(`DiffRun ${diffRunId} not found`);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: diffRun.shopDomain },
  });
  if (!shop) throw new Error(`Shop ${diffRun.shopDomain} not found — has the app been installed?`);

  await prisma.diffRun.update({
    where: { id: diffRunId },
    data: { status: "running" },
  });

  const ctx: PipelineContext = {
    diffRunId,
    shopDomain: diffRun.shopDomain,
    accessToken: shop.accessToken,
    baseThemeId: diffRun.baseThemeId,
    candidateThemeId: diffRun.candidateThemeId,
    prisma,
  };

  try {
    // ── Phase 1: Asset Diffs ──
    console.log("[worker] Phase 1: Asset diffs");
    const assetResult = await runAssetDiffs(ctx);
    console.log(`[worker] Asset diffs done: +${assetResult.added} -${assetResult.removed} ~${assetResult.modified}`);

    // ── Phase 2: Page Target Resolution ──
    console.log("[worker] Phase 2: Resolving page targets");
    const targetDefs = await resolvePageTargets(ctx);
    const targetIds = await createPageTargetRecords(ctx, targetDefs);
    console.log(`[worker] Created ${targetIds.length} page targets`);

    // Load shop settings
    const settings = await prisma.shopSetting.findUnique({
      where: { shopDomain: diffRun.shopDomain },
    });
    const storefrontPassword = settings?.storefrontPassword ?? null;
    const hideSelectors = settings?.hideSelectors ?? null;

    const storage = createStorageProvider();

    // ── Phase 3: Per-target processing ──
    console.log("[worker] Phase 3: Processing page targets");
    let screenshotsComplete = 0;
    let screenshotsFailed = 0;
    let maxMismatchPercent = 0;
    const allRegressions: Array<{ checkName: string; pageType: string }> = [];

    for (let i = 0; i < targetIds.length; i++) {
      const pageTargetId = targetIds[i];
      const targetDef = targetDefs[i];
      console.log(`[worker] Target ${i + 1}/${targetIds.length}: ${targetDef.pageType} (${targetDef.path})`);

      try {
        // a. Capture base screenshot (keep page open for checks)
        const baseUrl = buildPreviewUrl(ctx.shopDomain, ctx.baseThemeId, targetDef.path);
        const baseResult = await capturePageTargetScreenshots(
          ctx, pageTargetId, "base", baseUrl, targetDef.pageType,
          storefrontPassword, hideSelectors, storage,
        );

        // b. Run DOM checks on base page, then close context
        const baseChecks = await runChecksOnPage(baseResult.page, targetDef.pageType);
        await baseResult.context.close();

        // c. Capture candidate screenshot (keep page open for checks)
        const candidateUrl = buildPreviewUrl(ctx.shopDomain, ctx.candidateThemeId, targetDef.path);
        const candidateResult = await capturePageTargetScreenshots(
          ctx, pageTargetId, "candidate", candidateUrl, targetDef.pageType,
          storefrontPassword, hideSelectors, storage,
        );

        // d. Run DOM checks on candidate page, then close context
        const candidateChecks = await runChecksOnPage(candidateResult.page, targetDef.pageType);
        await candidateResult.context.close();

        // e. Generate visual diff
        const basePath = `runs/${ctx.diffRunId}/base-${targetDef.pageType}.png`;
        const candidatePath = `runs/${ctx.diffRunId}/candidate-${targetDef.pageType}.png`;
        const diffResult = await generateVisualDiff(
          ctx, pageTargetId, targetDef.pageType, basePath, candidatePath, storage,
        );

        if (diffResult.mismatchPercent > maxMismatchPercent) {
          maxMismatchPercent = diffResult.mismatchPercent;
        }

        // f. Persist check results
        const checkResult = await persistCheckResults(ctx, pageTargetId, baseChecks, candidateChecks);
        allRegressions.push(...checkResult.regressions);

        // Mark target complete
        await ctx.prisma.pageTarget.update({
          where: { id: pageTargetId },
          data: { status: "complete" },
        });
        screenshotsComplete++;
      } catch (err) {
        console.error(`[worker] Target ${targetDef.pageType} failed:`, (err as Error).message);
        await ctx.prisma.pageTarget.update({
          where: { id: pageTargetId },
          data: {
            status: "failed",
            errorMessage: (err as Error).message.slice(0, 500),
          },
        });
        screenshotsFailed++;
      }
    }

    // ── Phase 4: Finalize ──
    console.log("[worker] Phase 4: Finalizing");
    await closeBrowser();

    const allTargetsFailed = targetIds.length > 0 && screenshotsFailed === targetIds.length;

    const summary = {
      ...assetResult,
      pageTargets: targetIds.length,
      screenshotsComplete,
      screenshotsFailed,
      maxMismatchPercent: Math.round(maxMismatchPercent * 100) / 100,
      riskCount: allRegressions.length,
      regressions: allRegressions,
    };

    await prisma.diffRun.update({
      where: { id: diffRunId },
      data: {
        status: allTargetsFailed ? "failed" : "complete",
        summary,
        errorMessage: allTargetsFailed ? "All page targets failed" : null,
      },
    });

    console.log(
      `[worker] Diff complete: ${diffRunId} — ` +
        `assets: +${assetResult.added} -${assetResult.removed} ~${assetResult.modified}, ` +
        `screenshots: ${screenshotsComplete}/${targetIds.length}, ` +
        `regressions: ${allRegressions.length}`,
    );
  } catch (err) {
    console.error(`[worker] Diff failed: ${diffRunId}`, (err as Error).message);
    await closeBrowser();
    await prisma.diffRun.update({
      where: { id: diffRunId },
      data: {
        status: "failed",
        errorMessage: (err as Error).message.slice(0, 500),
      },
    });
    throw err;
  }
}

// ── Start worker ─────────────────────────────────────────────────────

const worker = new Worker("theme-diff", processDiffJob, {
  connection: connectionConfig,
  concurrency: 1,
  lockDuration: 600_000, // 10 min — Playwright screenshots take longer
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
async function shutdown() {
  console.log("[worker] Shutting down...");
  await closeBrowser();
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
