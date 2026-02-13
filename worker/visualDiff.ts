import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { PipelineContext, StorageProvider } from "./types.js";

function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

function normalizeDimensions(
  img1: PNG,
  img2: PNG,
): { img1: PNG; img2: PNG; width: number; height: number } {
  const width = Math.max(img1.width, img2.width);
  const height = Math.max(img1.height, img2.height);

  function pad(src: PNG, w: number, h: number): PNG {
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

  return {
    img1: pad(img1, width, height),
    img2: pad(img2, width, height),
    width,
    height,
  };
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

  const { img1, img2, width, height } = normalizeDimensions(
    baseImg,
    candidateImg,
  );

  const diff = new PNG({ width, height });
  const totalPixels = width * height;

  const mismatchCount = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 },
  );

  const mismatchPercent =
    totalPixels > 0 ? (mismatchCount / totalPixels) * 100 : 0;

  const diffOutputPath = `runs/${ctx.diffRunId}/diff-${pageType}.png`;
  const diffBuffer = PNG.sync.write(diff);
  await storage.write(diffOutputPath, diffBuffer);

  await ctx.prisma.visualDiff.create({
    data: {
      pageTargetId,
      diffFilePath: diffOutputPath,
      mismatchCount,
      mismatchPercent: Math.round(mismatchPercent * 100) / 100,
      totalPixels,
    },
  });

  return { mismatchPercent };
}
