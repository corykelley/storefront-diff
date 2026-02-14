import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { PipelineContext, StorageProvider } from "./types.js";

function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

/** Pad an image to target dimensions, filling extra space with white. */
function padToSize(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;

  const padded = new PNG({ width: w, height: h, fill: true });
  // Fill with white
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = 255;
    padded.data[i + 1] = 255;
    padded.data[i + 2] = 255;
    padded.data[i + 3] = 255;
  }
  // Copy source pixels
  PNG.bitblt(src, padded, 0, 0, src.width, src.height, 0, 0);
  return padded;
}

export async function generateVisualDiff(
  ctx: PipelineContext,
  pageTargetId: string,
  pageType: string,
  basePath: string,
  candidatePath: string,
  storage: StorageProvider,
): Promise<{ mismatchPercent: number }> {
  const baseBuffer = await readFile(join("./public", basePath));
  const candidateBuffer = await readFile(join("./public", candidatePath));

  const baseImg = decodePng(baseBuffer);
  const candidateImg = decodePng(candidateBuffer);

  // ── Full-canvas diff (for the visual diff image) ──
  const fullWidth = Math.max(baseImg.width, candidateImg.width);
  const fullHeight = Math.max(baseImg.height, candidateImg.height);
  const paddedBase = padToSize(baseImg, fullWidth, fullHeight);
  const paddedCandidate = padToSize(candidateImg, fullWidth, fullHeight);

  const diffImage = new PNG({ width: fullWidth, height: fullHeight });
  const totalPixels = fullWidth * fullHeight;

  const mismatchCount = pixelmatch(
    paddedBase.data,
    paddedCandidate.data,
    diffImage.data,
    fullWidth,
    fullHeight,
    { threshold: 0.05, includeAA: true },
  );

  const diffOutputPath = `runs/${ctx.diffRunId}/diff-${pageType}.png`;
  const diffBuffer = PNG.sync.write(diffImage);
  await storage.write(diffOutputPath, diffBuffer);

  const mismatchPercent =
    totalPixels > 0 ? (mismatchCount / totalPixels) * 100 : 0;

  await ctx.prisma.visualDiff.create({
    data: {
      pageTargetId,
      diffFilePath: diffOutputPath,
      mismatchCount,
      mismatchPercent: Math.round(mismatchPercent * 100) / 100,
      totalPixels,
      effectivePixels: totalPixels,
    },
  });

  return { mismatchPercent };
}
