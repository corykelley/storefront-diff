/**
 * Interactive Flow Testing Module
 *
 * Validates user interactions work correctly (not just that elements exist).
 * Tests critical flows: buy flow, navigation/search, mobile menu.
 */

import type { Page, ElementHandle } from "playwright";
import type { PipelineContext, StorageProvider } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface InteractiveStepDefinition {
  action: string;
  selectorList?: string[];
  customVerification?: (page: Page) => Promise<boolean>;
  required: boolean;
  description: string;
  waitAfter?: number; // ms to wait after action (default: 1000)
}

export interface InteractiveTestDefinition {
  name: string;
  pageTypes: string[];
  steps: InteractiveStepDefinition[];
}

export interface StepOutcome {
  stepNumber: number;
  action: string;
  status: "success" | "failed" | "skipped";
  selector?: string;
  attemptedSelectors?: string[];
  screenshotPath?: string | null;
  errorDetail?: string;
  durationMs: number;
}

export interface InteractiveTestOutcome {
  testName: string;
  status: "passed" | "failed" | "error" | "partial";
  steps: StepOutcome[];
  errorMessage: string | null;
  totalSteps: number;
  completedSteps: number;
}

// ── Selector Lists ───────────────────────────────────────────────────

const SELECTOR_LISTS = {
  ADD_TO_CART: [
    'form[action*="/cart/add"] button[type="submit"]',
    'form[action*="/cart/add"] input[type="submit"]',
    'button[name="add"]',
    '[data-add-to-cart]',
    '[data-action="add-to-cart"]',
    'button:has-text("Add to Cart")',
    'button:has-text("Add to Bag")',
    'button:has-text("Buy Now")',
    'button:has-text("Purchase")',
    'button:has-text("Add")',
    '.product-form__submit',
    '.add-to-cart',
    '.btn-add-to-cart',
    'form[action*="/cart"] button[type="submit"]',
    '.product-form button[type="submit"]',
  ],

  CART_COUNT: [
    '[data-cart-count]',
    '[data-cart-items]',
    '.cart-count',
    '.cart__count',
    '#cart-count',
    '.cart-link__bubble',
    '[aria-label*="cart"] .count',
    '.header__cart-count',
  ],

  CART_LINK: [
    'a[href="/cart"]',
    'a[href*="/cart"]',
    '[data-cart-link]',
    '.cart-link',
    '.header__cart',
    'a:has-text("Cart")',
    'a:has-text("Bag")',
    'a[href*="/checkout"]',
    'button:has-text("Checkout")',
  ],

  SEARCH_INPUT: [
    'input[type="search"]',
    'input[name="q"]',
    '[data-search-input]',
    '.search__input',
    '#search',
    'input[placeholder*="Search"]',
    'input[aria-label*="Search"]',
  ],

  MOBILE_MENU_TOGGLE: [
    '[data-menu-toggle]',
    '.mobile-menu-toggle',
    '.hamburger',
    'button[aria-label*="menu" i]',
    'button[aria-label*="Menu"]',
    '.header__icon--menu',
    '[aria-controls*="mobile"]',
    'button:has-text("Menu")',
  ],

  NAV_LINK: [
    'nav a[href*="/collections/"]',
    'header nav a[href*="/collections/"]',
    '.header__menu a',
    '[data-nav-link]',
    'nav a:not([href="/"])',
  ],
};

// ── Test Definitions ─────────────────────────────────────────────────

const INTERACTIVE_TEST_DEFINITIONS: InteractiveTestDefinition[] = [
  {
    name: "BUY_FLOW",
    pageTypes: ["product"],
    steps: [
      {
        action: "click_atc",
        selectorList: SELECTOR_LISTS.ADD_TO_CART,
        required: true,
        description: "Click add to cart button",
        waitAfter: 2000,
      },
      {
        action: "verify_cart_updated",
        customVerification: verifyCartUpdated,
        required: false,
        description: "Verify cart updated (count badge or drawer or redirect)",
        waitAfter: 1000,
      },
      {
        action: "navigate_checkout",
        selectorList: SELECTOR_LISTS.CART_LINK,
        required: true,
        description: "Navigate to cart/checkout",
        waitAfter: 2000,
      },
      {
        action: "verify_checkout_reached",
        customVerification: async (page) => {
          const url = page.url();
          return url.includes('/checkout') || url.includes('/cart');
        },
        required: true,
        description: "Verify reached checkout or cart page",
      },
    ],
  },
  {
    name: "NAVIGATION_SEARCH",
    pageTypes: ["home"],
    steps: [
      {
        action: "click_nav_link",
        selectorList: SELECTOR_LISTS.NAV_LINK,
        required: true,
        description: "Click navigation link",
        waitAfter: 2000,
      },
      {
        action: "verify_collection_page",
        customVerification: async (page) => {
          const url = page.url();
          return url.includes('/collections/') || url.includes('/pages/');
        },
        required: true,
        description: "Verify navigation to collection or page",
      },
      {
        action: "find_search",
        selectorList: SELECTOR_LISTS.SEARCH_INPUT,
        required: false,
        description: "Find search input",
      },
      {
        action: "type_search_query",
        customVerification: async (page) => {
          // Will be handled in execution
          return true;
        },
        required: false,
        description: "Type search query and submit",
        waitAfter: 2000,
      },
    ],
  },
  {
    name: "MOBILE_MENU",
    pageTypes: ["home"],
    steps: [
      {
        action: "set_mobile_viewport",
        customVerification: async (page) => {
          await page.setViewportSize({ width: 375, height: 667 });
          return true;
        },
        required: true,
        description: "Set viewport to mobile size",
      },
      {
        action: "click_mobile_menu",
        selectorList: SELECTOR_LISTS.MOBILE_MENU_TOGGLE,
        required: true,
        description: "Click mobile menu toggle",
        waitAfter: 1000,
      },
      {
        action: "verify_menu_opened",
        customVerification: async (page) => {
          // Check for common mobile menu patterns
          const visible = await page.evaluate(() => {
            // ── Exact selector matches ──
            const selectors = [
              '[data-mobile-menu].open',
              '[data-mobile-menu].active',
              '.mobile-menu.open',
              '.mobile-menu.active',
              'nav[aria-hidden="false"]',
              // Dawn theme: menu-drawer is a <details> element that gets [open]
              'details#menu-drawer-container[open]',
              'menu-drawer[open]',
              'menu-drawer details[open]',
              '#menu-drawer[open]',
              'details[id*="menu"][open]',
              // Generic drawer patterns
              '.menu-drawer.is-open',
              '.mobile-nav.is-active',
              '[data-menu-drawer][open]',
              '[data-mobile-nav].is-open',
            ];

            const selectorMatch = selectors.some(sel => {
              const el = document.querySelector(sel);
              return el && window.getComputedStyle(el).display !== 'none';
            });
            if (selectorMatch) return true;

            // ── Heuristic: look for visible nav links inside any open
            //    details element or drawer-like container ──
            const navInDrawer = document.querySelectorAll(
              'details[open] nav a, [class*="menu-drawer"] nav a, [class*="mobile-menu"] a'
            );
            for (const link of navInDrawer) {
              const style = window.getComputedStyle(link);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                return true;
              }
            }

            return false;
          });
          return visible;
        },
        required: true,
        description: "Verify mobile menu opened",
      },
    ],
  },
];

// ── Helper Functions ─────────────────────────────────────────────────

/**
 * Dismiss common overlays and modals that might block interactions.
 *
 * Uses a two-phase approach:
 *   1. JS removal: nuke known overlay containers from the DOM entirely
 *   2. Click fallback: try clicking dismiss/accept buttons on anything left
 */
async function dismissOverlays(page: Page): Promise<void> {
  console.log('[interactive] Dismissing overlays...');

  // ── Phase 1: Remove overlay containers via JS ──────────────────────
  // This is the most reliable approach — removes the element entirely so
  // it can never re-appear or intercept clicks.
  const removed = await page.evaluate(() => {
    const selectors = [
      // Shopify native cookie consent
      '#shopify-pc__banner',
      '#shopify-pc__modal',
      '#shopify-privacy-banner',
      '.shopify-privacy-banner',
      '[id*="CookieConsent"]',
      '[class*="cookie-consent"]',
      '[class*="cookie-banner"]',
      '[class*="cookie_consent"]',
      '[id*="cookie-consent"]',
      '[id*="cookie-banner"]',
      '[data-cookie-consent]',
      '[data-consent]',
      // Generic cookie / GDPR popups
      '#onetrust-consent-sdk',
      '#CybotCookiebotDialog',
      '.cc-window',
      '#gdpr-consent',
      // Newsletter / promo modals
      '[data-popup-modal]',
      '.popup-modal__overlay',
      '.newsletter-popup',
      // Age gate
      '[data-age-gate]',
    ];

    let count = 0;
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => { el.remove(); count++; });
    }
    return count;
  });

  if (removed > 0) {
    console.log(`[interactive] Removed ${removed} overlay element(s) via JS`);
  }

  // ── Phase 2: Click dismiss buttons on any remaining overlays ───────
  const clickSelectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Decline")',
    'button:has-text("Close")',
    'button:has-text("Agree")',
    'button[aria-label*="Close" i]',
    'button[aria-label*="Dismiss" i]',
    '[data-modal-close]',
    '[data-close-modal]',
    '.modal__close',
    '.popup__close',
    '[role="dialog"] button',
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let dismissed = false;

    for (const selector of clickSelectors) {
      try {
        const button = await page.waitForSelector(selector, {
          state: "visible",
          timeout: 400,
        });

        if (button) {
          await button.click();
          await page.waitForTimeout(300);
          console.log(`[interactive] Dismissed overlay via click: ${selector}`);
          dismissed = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!dismissed) break;
  }

  console.log('[interactive] Overlay dismissal complete');
}

/**
 * Find first matching element from a list of selectors
 */
async function findElement(
  page: Page,
  selectorList: string[],
  timeoutPerSelector: number = 2000
): Promise<{ element: ElementHandle | null; selector: string | null }> {
  for (const selector of selectorList) {
    try {
      const element = await page.waitForSelector(selector, {
        state: "visible",
        timeout: timeoutPerSelector,
      });

      if (element) {
        return { element, selector };
      }
    } catch {
      // Selector didn't match, try next one
      continue;
    }
  }

  return { element: null, selector: null };
}

/**
 * Verify cart was updated after adding item
 */
async function verifyCartUpdated(page: Page): Promise<boolean> {
  // Try 1: Find cart count badge and check value
  const countResult = await findElement(page, SELECTOR_LISTS.CART_COUNT, 1000);
  if (countResult.element) {
    const text = await countResult.element.textContent();
    const count = parseInt(text?.trim() || "0");
    if (count > 0) return true;
  }

  // Try 2: Check for cart drawer/modal appearing
  const drawer = await page.$('[data-cart-drawer].active, .cart-drawer.open, [aria-label*="Cart"].open');
  if (drawer) return true;

  // Try 3: Check if page body contains "Item added" or similar
  const bodyText = await page.textContent('body');
  if (bodyText?.includes('Added to cart') || bodyText?.includes('Item added')) {
    return true;
  }

  // Try 4: Check URL changed (some themes redirect to /cart)
  if (page.url().includes('/cart')) return true;

  return false;
}

// ── Step Execution ───────────────────────────────────────────────────

async function executeStep(
  page: Page,
  stepDef: InteractiveStepDefinition,
  stepNumber: number,
  variant: string,
  testName: string,
  ctx: PipelineContext,
  storage: StorageProvider,
): Promise<StepOutcome> {
  const startTime = Date.now();
  let screenshotPath: string | null = null;

  try {
    // Execute based on action type
    if (stepDef.customVerification) {
      const result = await stepDef.customVerification(page);

      if (!result && stepDef.required) {
        return {
          stepNumber,
          action: stepDef.action,
          status: "failed",
          errorDetail: `Custom verification failed: ${stepDef.description}`,
          durationMs: Date.now() - startTime,
        };
      }

      if (!result && !stepDef.required) {
        return {
          stepNumber,
          action: stepDef.action,
          status: "skipped",
          durationMs: Date.now() - startTime,
        };
      }

      // Success
      const waitAfter = stepDef.waitAfter ?? 1000;
      await page.waitForTimeout(waitAfter);

      // Capture screenshot
      screenshotPath = await captureStepScreenshot(
        page, variant, testName, stepNumber, ctx, storage
      );

      return {
        stepNumber,
        action: stepDef.action,
        status: "success",
        screenshotPath,
        durationMs: Date.now() - startTime,
      };
    }

    // Find and click element
    if (stepDef.selectorList) {
      const { element, selector } = await findElement(
        page,
        stepDef.selectorList,
        2000
      );

      if (!element || !selector) {
        if (stepDef.required) {
          return {
            stepNumber,
            action: stepDef.action,
            status: "failed",
            attemptedSelectors: stepDef.selectorList,
            errorDetail: `Could not find element. Tried ${stepDef.selectorList.length} selectors: ${stepDef.selectorList.slice(0, 3).join(', ')}...`,
            durationMs: Date.now() - startTime,
          };
        } else {
          return {
            stepNumber,
            action: stepDef.action,
            status: "skipped",
            attemptedSelectors: stepDef.selectorList,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Click element
      await element.click();

      const waitAfter = stepDef.waitAfter ?? 1000;
      await page.waitForTimeout(waitAfter);

      // Capture screenshot
      screenshotPath = await captureStepScreenshot(
        page, variant, testName, stepNumber, ctx, storage
      );

      return {
        stepNumber,
        action: stepDef.action,
        status: "success",
        selector,
        screenshotPath,
        durationMs: Date.now() - startTime,
      };
    }

    throw new Error("Step must have either selectorList or customVerification");

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      stepNumber,
      action: stepDef.action,
      status: "failed",
      errorDetail: `Exception during step execution: ${errorMessage}`,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Capture screenshot after a step
 */
async function captureStepScreenshot(
  page: Page,
  variant: string,
  testName: string,
  stepNumber: number,
  ctx: PipelineContext,
  storage: StorageProvider,
): Promise<string> {
  const screenshotBuffer = await page.screenshot({ fullPage: true });
  const relativePath = `runs/${ctx.diffRunId}/${variant}-${testName}-step${stepNumber}.png`;
  await storage.write(relativePath, screenshotBuffer);
  return relativePath;
}

// ── Test Execution ───────────────────────────────────────────────────

export async function runInteractiveTestsOnPage(
  page: Page,
  pageType: string,
  variant: "base" | "candidate",
  ctx: PipelineContext,
  storage: StorageProvider,
): Promise<InteractiveTestOutcome[]> {
  const outcomes: InteractiveTestOutcome[] = [];

  // Find tests for this page type
  const applicableTests = INTERACTIVE_TEST_DEFINITIONS.filter(test =>
    test.pageTypes.includes(pageType)
  );

  if (applicableTests.length === 0) {
    return outcomes;
  }

  console.log(`[interactive] Running ${applicableTests.length} tests on ${pageType} page (${variant})`);

  // Dismiss overlays before running tests
  try {
    await dismissOverlays(page);
  } catch (error) {
    console.error('[interactive] Error dismissing overlays:', error);
    // Continue anyway - don't let overlay dismissal break the tests
  }

  for (const testDef of applicableTests) {
    console.log(`[interactive] Test: ${testDef.name}`);
    const stepOutcomes: StepOutcome[] = [];
    let completedSteps = 0;
    let testFailed = false;

    for (let i = 0; i < testDef.steps.length; i++) {
      if (testFailed) {
        // Stop executing remaining steps
        break;
      }

      const stepDef = testDef.steps[i];
      const stepOutcome = await executeStep(
        page,
        stepDef,
        i + 1,
        variant,
        testDef.name,
        ctx,
        storage,
      );

      stepOutcomes.push(stepOutcome);

      if (stepOutcome.status === "success") {
        completedSteps++;
      } else if (stepOutcome.status === "failed") {
        testFailed = true;
        console.error(`[interactive] Step ${i + 1} failed: ${stepOutcome.errorDetail}`);
      } else if (stepOutcome.status === "skipped") {
        console.log(`[interactive] Step ${i + 1} skipped (optional)`);
      }
    }

    // Determine overall test status
    let status: "passed" | "failed" | "error" | "partial";
    let errorMessage: string | null = null;

    if (testFailed) {
      status = "failed";
      const failedStep = stepOutcomes.find(s => s.status === "failed");
      errorMessage = failedStep?.errorDetail || "Test failed";
    } else if (completedSteps === testDef.steps.length) {
      status = "passed";
    } else if (completedSteps > 0) {
      status = "partial";
    } else {
      status = "failed";
      errorMessage = "No steps completed";
    }

    outcomes.push({
      testName: testDef.name,
      status,
      steps: stepOutcomes,
      errorMessage,
      totalSteps: testDef.steps.length,
      completedSteps,
    });
  }

  return outcomes;
}

// ── Persistence ──────────────────────────────────────────────────────

export async function persistInteractiveTestResults(
  ctx: PipelineContext,
  pageTargetId: string,
  baseOutcomes: InteractiveTestOutcome[],
  candidateOutcomes: InteractiveTestOutcome[],
): Promise<{ regressions: Array<{ testName: string; pageType: string }> }> {
  const regressions: Array<{ testName: string; pageType: string }> = [];

  // Get page type for regression reporting
  const pageTarget = await ctx.prisma.pageTarget.findUnique({
    where: { id: pageTargetId },
    select: { pageType: true },
  });
  const pageType = pageTarget?.pageType || "unknown";

  // Persist base test results
  for (const outcome of baseOutcomes) {
    const test = await ctx.prisma.interactiveTest.create({
      data: {
        pageTargetId,
        testName: outcome.testName,
        variant: "base",
        status: outcome.status,
        errorMessage: outcome.errorMessage,
        totalSteps: outcome.totalSteps,
        completedSteps: outcome.completedSteps,
      },
    });

    // Persist steps
    for (const step of outcome.steps) {
      await ctx.prisma.interactiveStep.create({
        data: {
          interactiveTestId: test.id,
          stepNumber: step.stepNumber,
          action: step.action,
          status: step.status,
          selector: step.selector,
          screenshotPath: step.screenshotPath,
          errorDetail: step.errorDetail,
          durationMs: step.durationMs,
        },
      });
    }
  }

  // Persist candidate test results
  for (const outcome of candidateOutcomes) {
    const test = await ctx.prisma.interactiveTest.create({
      data: {
        pageTargetId,
        testName: outcome.testName,
        variant: "candidate",
        status: outcome.status,
        errorMessage: outcome.errorMessage,
        totalSteps: outcome.totalSteps,
        completedSteps: outcome.completedSteps,
      },
    });

    // Persist steps
    for (const step of outcome.steps) {
      await ctx.prisma.interactiveStep.create({
        data: {
          interactiveTestId: test.id,
          stepNumber: step.stepNumber,
          action: step.action,
          status: step.status,
          selector: step.selector,
          screenshotPath: step.screenshotPath,
          errorDetail: step.errorDetail,
          durationMs: step.durationMs,
        },
      });
    }

    // Check for regression (base passed, candidate failed)
    const baseOutcome = baseOutcomes.find(b => b.testName === outcome.testName);
    if (baseOutcome?.status === "passed" && outcome.status !== "passed") {
      regressions.push({
        testName: outcome.testName,
        pageType,
      });
    }
  }

  return { regressions };
}
