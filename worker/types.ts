import type { PrismaClient } from "@prisma/client";

export interface PipelineContext {
  diffRunId: string;
  shopDomain: string;
  accessToken: string;
  baseThemeId: bigint;
  candidateThemeId: bigint;
  prisma: PrismaClient;
}

export interface PageTargetDef {
  pageType: string;
  path: string;
  handle?: string;
}

export interface StorageProvider {
  write(relativePath: string, data: Buffer): Promise<void>;
  publicUrl(relativePath: string): string;
}

export type CheckName =
  | "HOME_NAV_LINKS_PRESENT"
  | "PDP_ATC_PRESENT"
  | "PDP_PRICE_PRESENT"
  | "PDP_PRODUCT_FORM_PRESENT"
  | "CART_CONTAINER_PRESENT";

export interface CheckDefinition {
  name: CheckName;
  pageTypes: string[];
  selector: string;
}

export interface CheckOutcome {
  checkName: CheckName;
  passed: boolean;
  selector: string;
  detail?: string;
}

// ── Interactive Tests ────────────────────────────────────────────────

export interface InteractiveTestOutcome {
  testName: string;
  status: "passed" | "failed" | "error" | "partial";
  steps: StepOutcome[];
  errorMessage: string | null;
  totalSteps: number;
  completedSteps: number;
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
