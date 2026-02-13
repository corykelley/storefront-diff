import type { Page } from "playwright";
import type { CheckDefinition, CheckOutcome, PipelineContext } from "./types.js";

const CHECK_DEFINITIONS: CheckDefinition[] = [
  {
    name: "HOME_NAV_LINKS_PRESENT",
    pageTypes: ["home"],
    selector: "nav a, header a, [role='navigation'] a",
  },
  {
    name: "PDP_ATC_PRESENT",
    pageTypes: ["product"],
    selector:
      'form[action*="/cart/add"] button[type="submit"], button[name="add"], [data-add-to-cart]',
  },
  {
    name: "PDP_PRICE_PRESENT",
    pageTypes: ["product"],
    selector:
      '[class*="price"], [data-product-price], .product-price, .price',
  },
  {
    name: "PDP_PRODUCT_FORM_PRESENT",
    pageTypes: ["product"],
    selector: 'form[action*="/cart/add"], product-form, .product-form',
  },
  {
    name: "CART_CONTAINER_PRESENT",
    pageTypes: ["cart"],
    selector: 'form[action*="/cart"], .cart, [data-cart], cart-items',
  },
];

export async function runChecksOnPage(
  page: Page,
  pageType: string,
): Promise<CheckOutcome[]> {
  const applicable = CHECK_DEFINITIONS.filter((c) =>
    c.pageTypes.includes(pageType),
  );

  const results: CheckOutcome[] = [];

  for (const check of applicable) {
    try {
      const el = await page.$(check.selector);
      results.push({
        checkName: check.name,
        passed: el !== null,
        selector: check.selector,
        detail: el ? "Element found" : "Element not found",
      });
    } catch (err) {
      results.push({
        checkName: check.name,
        passed: false,
        selector: check.selector,
        detail: `Error: ${(err as Error).message}`,
      });
    }
  }

  return results;
}

export async function persistCheckResults(
  ctx: PipelineContext,
  pageTargetId: string,
  baseResults: CheckOutcome[],
  candidateResults: CheckOutcome[],
): Promise<{ regressions: Array<{ checkName: string; pageType: string }> }> {
  const rows = [
    ...baseResults.map((r) => ({
      pageTargetId,
      checkName: r.checkName,
      variant: "base" as const,
      passed: r.passed,
      selector: r.selector,
      detail: r.detail ?? null,
    })),
    ...candidateResults.map((r) => ({
      pageTargetId,
      checkName: r.checkName,
      variant: "candidate" as const,
      passed: r.passed,
      selector: r.selector,
      detail: r.detail ?? null,
    })),
  ];

  if (rows.length > 0) {
    await ctx.prisma.checkResult.createMany({ data: rows });
  }

  // Compute regressions: base passed but candidate failed
  const baseMap = new Map(baseResults.map((r) => [r.checkName, r.passed]));
  const regressions: Array<{ checkName: string; pageType: string }> = [];

  const target = await ctx.prisma.pageTarget.findUnique({
    where: { id: pageTargetId },
    select: { pageType: true },
  });

  for (const cr of candidateResults) {
    if (baseMap.get(cr.checkName) === true && !cr.passed) {
      regressions.push({
        checkName: cr.checkName,
        pageType: target?.pageType ?? "unknown",
      });
    }
  }

  return { regressions };
}
