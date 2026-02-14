# Visual Diff Engine

**File:** `worker/visualDiff.ts`

This module compares two screenshots pixel-by-pixel and produces a diff image highlighting the differences.

## How It Works

### Step 1: Read and Decode PNGs

```typescript
const baseBuffer = await readFile(join("./public", basePath));
const candidateBuffer = await readFile(join("./public", candidatePath));
const baseImg = decodePng(baseBuffer);
const candidateImg = decodePng(candidateBuffer);
```

Both images are decoded into `PNG` objects (from the `pngjs` library). Each PNG has a `data` property — a `Buffer` of raw RGBA pixels (4 bytes per pixel: red, green, blue, alpha).

### Step 2: Pad to Common Dimensions

```typescript
const fullWidth = Math.max(baseImg.width, candidateImg.width);
const fullHeight = Math.max(baseImg.height, candidateImg.height);
const paddedBase = padToSize(baseImg, fullWidth, fullHeight);
const paddedCandidate = padToSize(candidateImg, fullWidth, fullHeight);
```

Screenshots often have different heights. The home page on one theme might be 3000px tall, while on another it's 5000px tall. To compare them pixel-by-pixel, both images must be the same size.

**Padding strategy:** The smaller image is padded with **white pixels** to match the larger one. White was chosen because it's a reasonable "empty page" color and produces clear diff output.

```typescript
function padToSize(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const padded = new PNG({ width: w, height: h, fill: true });
  // Fill with white (RGBA: 255, 255, 255, 255)
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = 255;     // R
    padded.data[i + 1] = 255; // G
    padded.data[i + 2] = 255; // B
    padded.data[i + 3] = 255; // A
  }
  // Copy source pixels onto the white canvas
  PNG.bitblt(src, padded, 0, 0, src.width, src.height, 0, 0);
  return padded;
}
```

`PNG.bitblt()` is a block transfer operation — it copies a rectangular region of pixels from one image to another. Here it copies the original image into the top-left corner of the padded canvas.

### Step 3: Run pixelmatch

```typescript
const diffImage = new PNG({ width: fullWidth, height: fullHeight });
const totalPixels = fullWidth * fullHeight;

const mismatchCount = pixelmatch(
  paddedBase.data,
  paddedCandidate.data,
  diffImage.data,     // output: diff visualization
  fullWidth,
  fullHeight,
  { threshold: 0.05, includeAA: true },
);
```

**pixelmatch** is the core comparison engine. For each pixel:
1. Compares the RGBA values between the two images
2. If they differ by more than the threshold, marks it as mismatched
3. Writes the result to `diffImage` (mismatched pixels appear as bright red/magenta)

**Options:**
- `threshold: 0.05` — Tolerance for color differences. 0 = exact match, 1 = everything matches. 0.05 is very strict — catches subtle color changes but tolerates sub-pixel rendering differences.
- `includeAA: true` — Includes anti-aliased pixels in the mismatch count. Anti-aliasing is the smoothing on text and shape edges. Without this, font rendering differences would be ignored.

**Return value:** `mismatchCount` is the number of pixels that differ between the two images.

### Step 4: Save Diff Image

```typescript
const diffOutputPath = `runs/${ctx.diffRunId}/diff-${pageType}.png`;
const diffBuffer = PNG.sync.write(diffImage);
await storage.write(diffOutputPath, diffBuffer);
```

The diff image is saved as a PNG. In this image:
- **Matching pixels** appear as faded/dimmed versions of the original
- **Mismatched pixels** appear as bright red/magenta
- **Padded areas** (where one image is taller) show as red if the other image has content there

### Step 5: Calculate Mismatch Percentage

```typescript
const mismatchPercent = totalPixels > 0 ? (mismatchCount / totalPixels) * 100 : 0;
```

The percentage uses the **full padded canvas** as the denominator. This is important:

**Why not use the overlapping region?**

If theme A's home page is 2000px tall and theme B's is 4000px tall, the extra 2000px of content on theme B represents a significant visual change. Using only the overlap (2000px) would ignore all that extra content and underreport the difference.

By padding to 4000px and counting the padded area as mismatched, the percentage accurately reflects: "these pages look X% different overall."

### Step 6: Save to Database

```typescript
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
```

`mismatchPercent` is rounded to 2 decimal places. `effectivePixels` is set to `totalPixels` (the full canvas size).

## Understanding pixelmatch Output

The diff image uses a color scheme:

| Color | Meaning |
|---|---|
| Faded/dim | Pixels that match between both images |
| Bright red/magenta | Pixels that differ |
| Yellow (rare) | Anti-aliased pixels that differ |

If you see a big red block at the bottom of the diff, it means one theme's page is much taller than the other — the extra content shows up against the white padding.

## Example Mismatch Scenarios

**Identical pages:** `mismatchPercent ≈ 0%`
Only sub-pixel rendering differences.

**Same layout, different colors:** `mismatchPercent ≈ 15-40%`
Every pixel with changed colors counts.

**Completely different layouts:** `mismatchPercent ≈ 60-90%`
Most of the page differs.

**One page much taller:** `mismatchPercent` depends on ratio.
If page A is 2000px and page B is 4000px, at minimum 50% will be mismatched (the padding alone).

## Tuning the Threshold

The `threshold: 0.05` value can be adjusted:

- **Lower (e.g., 0.01):** More sensitive. Catches tiny color variations but may flag sub-pixel rendering artifacts.
- **Higher (e.g., 0.1):** More tolerant. Ignores minor color shifts but might miss subtle design changes.
- **0.05** is a good default for theme comparison — strict enough to catch intentional design changes, tolerant enough to not flag font rendering differences across runs.

If you find too many false positives (diffs that don't reflect real changes), increase the threshold. If you're missing real changes, decrease it.
