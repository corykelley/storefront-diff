import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PipelineContext, StorageProvider } from "./types.js";

const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 1;
const FREEZE_CSS = `*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }`;
const DOM_SETTLE_MS = 1500;

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

interface CaptureResult {
  filePath: string;
  width: number;
  height: number;
  page: Page;
  context: BrowserContext;
}

export async function captureScreenshot(options: {
  url: string;
  outputPath: string;
  storefrontPassword?: string | null;
  hideSelectors?: string | null;
  storage: StorageProvider;
}): Promise<CaptureResult> {
  const { url, outputPath, storefrontPassword, hideSelectors, storage } =
    options;
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });

    // Handle storefront password page
    if (storefrontPassword) {
      const passwordInput = await page.$('form input[type="password"]');
      if (passwordInput) {
        await passwordInput.fill(storefrontPassword);
        const submitBtn = await page.$('form button[type="submit"], form input[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForLoadState("networkidle", { timeout: 30_000 });
        }
        // Password submit redirects to "/", re-navigate to the intended URL
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
      }
    }

    // Inject freeze CSS to stop animations
    await page.addStyleTag({ content: FREEZE_CSS });

    // Hide specified selectors
    if (hideSelectors) {
      const selectors = hideSelectors
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (selectors.length > 0) {
        const css = selectors.map((s) => `${s} { visibility: hidden !important; }`).join("\n");
        await page.addStyleTag({ content: css });
      }
    }

    // Wait for DOM to settle
    await page.waitForTimeout(DOM_SETTLE_MS);

    // Take full-page screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: true });

    await storage.write(outputPath, Buffer.from(screenshotBuffer));

    // Get page dimensions
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    return {
      filePath: outputPath,
      width: dimensions.width,
      height: dimensions.height,
      page,
      context,
    };
  } catch (err) {
    await context.close();
    throw err;
  }
}

export async function capturePageTargetScreenshots(
  ctx: PipelineContext,
  pageTargetId: string,
  variant: "base" | "candidate",
  url: string,
  pageType: string,
  storefrontPassword: string | null,
  hideSelectors: string | null,
  storage: StorageProvider,
): Promise<{ page: Page; context: BrowserContext }> {
  const outputPath = `runs/${ctx.diffRunId}/${variant}-${pageType}.png`;

  const result = await captureScreenshot({
    url,
    outputPath,
    storefrontPassword,
    hideSelectors,
    storage,
  });

  await ctx.prisma.screenshot.create({
    data: {
      pageTargetId,
      variant,
      filePath: result.filePath,
      width: result.width,
      height: result.height,
    },
  });

  return { page: result.page, context: result.context };
}
