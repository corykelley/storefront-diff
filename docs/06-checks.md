# DOM Checks & Regression Detection

**File:** `worker/checks.ts`

DOM checks verify that critical elements exist on the page after the theme change. They answer: "Did the candidate theme break anything important?"

## Check Definitions

Each check is a simple CSS selector query:

```typescript
const CHECKS: CheckDefinition[] = [
  {
    name: "HOME_NAV_LINKS_PRESENT",
    pageTypes: ["home"],
    selector: 'nav a, header a, [role="navigation"] a',
  },
  {
    name: "PDP_ATC_PRESENT",
    pageTypes: ["product"],
    selector: 'form[action*="/cart/add"] button[type="submit"], button[name="add"], [data-add-to-cart]',
  },
  {
    name: "PDP_PRICE_PRESENT",
    pageTypes: ["product"],
    selector: '[class*="price"], [data-product-price], .product-price, .price',
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
```

### What Each Check Verifies

| Check | Page | What It Looks For |
|---|---|---|
| `HOME_NAV_LINKS_PRESENT` | Home | Navigation links exist (in `<nav>`, `<header>`, or `[role="navigation"]`) |
| `PDP_ATC_PRESENT` | Product | An "Add to Cart" button exists (submit button in a cart form, or `[data-add-to-cart]`) |
| `PDP_PRICE_PRESENT` | Product | A price element exists (class containing "price", or data attribute) |
| `PDP_PRODUCT_FORM_PRESENT` | Product | A product form exists (cart form, `<product-form>` web component, or `.product-form`) |
| `CART_CONTAINER_PRESENT` | Cart | A cart container exists (cart form, `.cart` class, or `<cart-items>` element) |

### Selector Strategy

Each check uses multiple comma-separated selectors to cover different theme implementations. Shopify themes vary widely:

- **Dawn** (Shopify's default) uses web components like `<product-form>` and data attributes like `[data-add-to-cart]`
- **Older themes** use class names like `.product-form` and `.price`
- **Custom themes** might use any convention

The selectors try to cover all common patterns. If a theme uses an unusual structure, the check might fail (false negative) even though the element exists.

## Running Checks

```typescript
export async function runChecksOnPage(
  page: Page,
  pageType: string,
): Promise<CheckOutcome[]>
```

This function:
1. Filters the check list to only checks that apply to this `pageType`
2. For each applicable check, queries the page using `page.$(selector)`
3. Returns pass/fail outcomes

```typescript
const el = await page.$(check.selector);
outcomes.push({
  checkName: check.name,
  passed: !!el,
  selector: check.selector,
  detail: el ? "Element found" : "Element not found",
});
```

`page.$()` is Playwright's query selector — it returns the first matching element or `null`.

**Important:** Checks run on the **live page** after the screenshot is taken. The page is still open in Playwright at this point. This is why `capturePageTargetScreenshots()` returns the `page` and `context` objects — so checks can run before the context is closed.

**Error handling:** If `page.$()` throws (e.g., invalid selector), the error is caught and the check is recorded as failed with the error message as `detail`.

## Which Checks Run on Which Pages

Checks only run on their designated page types:

```
home page    → HOME_NAV_LINKS_PRESENT
product page → PDP_ATC_PRESENT, PDP_PRICE_PRESENT, PDP_PRODUCT_FORM_PRESENT
cart page    → CART_CONTAINER_PRESENT
collection   → (no checks defined)
custom pages → (no checks defined)
```

Custom pages and collection pages currently have no checks. You could add them by defining new `CheckDefinition` entries with the appropriate `pageTypes`.

## Persisting Results & Detecting Regressions

```typescript
export async function persistCheckResults(
  ctx: PipelineContext,
  pageTargetId: string,
  baseResults: CheckOutcome[],
  candidateResults: CheckOutcome[],
): Promise<{ regressions: Array<{ checkName: string; pageType: string }> }>
```

This function:
1. Writes all check outcomes to the `CheckResult` table (one row per check per variant)
2. Detects **regressions**: checks where base passed but candidate failed

### What Counts as a Regression

```typescript
const regressions = [];
for (const baseCheck of baseResults) {
  const candidateCheck = candidateResults.find(c => c.checkName === baseCheck.checkName);
  if (baseCheck.passed && candidateCheck && !candidateCheck.passed) {
    regressions.push({ checkName: baseCheck.checkName, pageType });
  }
}
```

| Base | Candidate | Classification |
|---|---|---|
| Pass | Pass | No change (good) |
| Pass | Fail | **Regression** (bad — something broke) |
| Fail | Pass | Improvement (something was fixed) |
| Fail | Fail | No change (pre-existing issue) |

Only **Pass → Fail** is flagged as a regression. The UI highlights regressions with a critical banner.

## Adding New Checks

To add a new check:

1. **Define it** in the `CHECKS` array in `worker/checks.ts`:
   ```typescript
   {
     name: "COLLECTION_PRODUCT_GRID_PRESENT",
     pageTypes: ["collection"],
     selector: '.collection-products, [data-product-grid], .product-grid',
   },
   ```

2. **Add the type** to `CheckName` in `worker/types.ts`:
   ```typescript
   export type CheckName =
     | "HOME_NAV_LINKS_PRESENT"
     | "PDP_ATC_PRESENT"
     | ...
     | "COLLECTION_PRODUCT_GRID_PRESENT";
   ```

That's it. The pipeline will automatically:
- Run the new check on the specified page types
- Save results to the database
- Detect regressions
- Display results in the Checks tab

## Limitations

- **CSS-only changes:** If a button exists in the DOM but is hidden via CSS, the check still passes. The check only verifies DOM presence, not visibility.
- **Dynamic content:** If an element is loaded via JavaScript after `page.$()` runs, it might be missed. The 1.5-second DOM settle time helps, but isn't guaranteed.
- **Theme diversity:** The selectors try to cover common patterns but can't cover every custom theme's HTML structure.
- **No content validation:** Checks verify element existence, not content. A price element containing "$0.00" still passes.
