import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  isRouteErrorResponse,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  DataTable,
  Divider,
  InlineStack,
  Layout,
  Modal,
  Page,
  ProgressBar,
  Spinner,
  Tabs,
  Text,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "~/shopify.server";
import { notify } from "~/components/Notification";
import prisma from "~/db.server";

// ── Loader ───────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const diffRunId = params.diffRunId;
  if (!diffRunId) {
    throw new Response("Missing diffRunId", { status: 400 });
  }

  const diffRun = await prisma.diffRun.findUnique({
    where: { id: diffRunId },
    include: {
      assetDiffs: {
        orderBy: { key: "asc" },
      },
      pageTargets: {
        orderBy: { createdAt: "asc" },
        include: {
          screenshots: { orderBy: { variant: "asc" } },
          visualDiffs: true,
          checkResults: { orderBy: { checkName: "asc" } },
          interactiveTests: {
            orderBy: { testName: "asc" },
            include: {
              steps: { orderBy: { stepNumber: "asc" } },
            },
          },
        },
      },
    },
  });

  if (!diffRun) {
    throw new Response("DiffRun not found", { status: 404 });
  }

  return json({
    diffRun: {
      ...diffRun,
      baseThemeId: diffRun.baseThemeId.toString(),
      candidateThemeId: diffRun.candidateThemeId.toString(),
    },
  });
};

// ── Component ────────────────────────────────────────────────────────

export default function DiffRunPage() {
  const { diffRun } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = useState(0);
  const [zoomTarget, setZoomTarget] = useState<PageTargetData | null>(null);

  const isInProgress =
    diffRun.status === "queued" || diffRun.status === "running";

  // Poll while in progress
  useEffect(() => {
    if (!isInProgress) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 2000);
    return () => clearInterval(interval);
  }, [isInProgress, revalidator]);

  // Toast when diff completes
  const wasInProgressRef = useRef(isInProgress);
  useEffect(() => {
    if (wasInProgressRef.current && !isInProgress) {
      notify("Diff check complete");
    }
    wasInProgressRef.current = isInProgress;
  }, [isInProgress]);

  const summary = (diffRun.summary as any) || {};
  const pageTargets = diffRun.pageTargets ?? [];

  const tabs = [
    { id: "files", content: `Files (${diffRun.assetDiffs.length})` },
    { id: "visual", content: `Visual (${pageTargets.length})` },
    { id: "checks", content: "Checks" },
    { id: "flows", content: "Flows" },
  ];

  return (
    <Page
      title={`${diffRun.baseThemeName} → ${diffRun.candidateThemeName}`}
      subtitle={`Started ${new Date(diffRun.createdAt).toLocaleString()}`}
      backAction={{ content: "Back", onAction: () => navigate("/app/diff") }}
    >
      <Layout>
        {/* Status + Summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Status
                </Text>
                <StatusBadge status={diffRun.status} />
                {isInProgress && <Spinner size="small" />}
              </InlineStack>

              {diffRun.errorMessage && (
                <Box
                  padding="300"
                  background="bg-surface-critical"
                  borderRadius="200"
                >
                  <Text as="p" tone="critical">
                    {diffRun.errorMessage}
                  </Text>
                </Box>
              )}

              {diffRun.status === "complete" && (
                <InlineStack gap="400" wrap>
                  <SummaryChip label="Added" count={summary.added || 0} tone="success" />
                  <SummaryChip label="Removed" count={summary.removed || 0} tone="critical" />
                  <SummaryChip label="Modified" count={summary.modified || 0} tone="caution" />
                  <SummaryChip label="Skipped" count={summary.skipped || 0} tone="subdued" />
                  {summary.pageTargets > 0 && (
                    <>
                      <SummaryChip label="Pages" count={summary.pageTargets} tone="info" />
                      <SummaryChip
                        label="Max Mismatch"
                        count={`${summary.maxMismatchPercent ?? 0}%`}
                        tone="warning"
                      />
                      {summary.riskCount > 0 && (
                        <SummaryChip label="Regressions" count={summary.riskCount} tone="critical" />
                      )}
                    </>
                  )}
                </InlineStack>
              )}

              {isInProgress && (
                <ProgressBar progress={diffRun.status === "running" ? 50 : 10} size="small" />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Tabs */}
        {diffRun.status === "complete" && (
          <Layout.Section>
            <Card padding="0">
              <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                <Box padding="400">
                  {selectedTab === 0 && <FilesTab assetDiffs={diffRun.assetDiffs} />}
                  {selectedTab === 1 && <VisualTab pageTargets={pageTargets} onZoom={setZoomTarget} />}
                  {selectedTab === 2 && <ChecksTab pageTargets={pageTargets} />}
                  {selectedTab === 3 && <FlowsTab pageTargets={pageTargets} />}
                </Box>
              </Tabs>
            </Card>
          </Layout.Section>
        )}
      </Layout>

      {/* Screenshot zoom modal */}
      <ScreenshotZoomModal
        target={zoomTarget}
        onClose={() => setZoomTarget(null)}
      />
    </Page>
  );
}

// ── Files Tab ────────────────────────────────────────────────────────

function FilesTab({ assetDiffs }: { assetDiffs: AssetDiffRow[] }) {
  const grouped = groupByChangeType(assetDiffs);

  return (
    <BlockStack gap="400">
      {grouped.added.length > 0 && (
        <DiffGroup
          title={`Added (${grouped.added.length})`}
          tone="success"
          diffs={grouped.added}
        />
      )}
      {grouped.removed.length > 0 && (
        <DiffGroup
          title={`Removed (${grouped.removed.length})`}
          tone="critical"
          diffs={grouped.removed}
        />
      )}
      {grouped.modified.length > 0 && (
        <DiffGroup
          title={`Modified (${grouped.modified.length})`}
          tone="warning"
          diffs={grouped.modified}
          showDiff
        />
      )}
      {grouped.skipped.length > 0 && (
        <DiffGroup
          title={`Skipped (${grouped.skipped.length})`}
          tone="info"
          diffs={grouped.skipped}
        />
      )}
      {assetDiffs.length === 0 && (
        <Text as="p" tone="subdued">No file changes detected.</Text>
      )}
    </BlockStack>
  );
}

// ── Visual Tab ───────────────────────────────────────────────────────

function VisualTab({
  pageTargets,
  onZoom,
}: {
  pageTargets: PageTargetData[];
  onZoom: (target: PageTargetData) => void;
}) {
  if (pageTargets.length === 0) {
    return <Text as="p" tone="subdued">No visual comparisons available.</Text>;
  }

  return (
    <BlockStack gap="600">
      {pageTargets.map((target) => (
        <PageTargetVisual key={target.id} target={target} onZoom={onZoom} />
      ))}
    </BlockStack>
  );
}

function PageTargetVisual({
  target,
  onZoom,
}: {
  target: PageTargetData;
  onZoom: (target: PageTargetData) => void;
}) {
  const baseScreenshot = target.screenshots.find((s) => s.variant === "base");
  const candidateScreenshot = target.screenshots.find((s) => s.variant === "candidate");
  const visualDiff = target.visualDiffs[0];

  const handleZoom = useCallback(() => onZoom(target), [onZoom, target]);

  return (
    <BlockStack gap="300">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h3" variant="headingSm">
          {target.pageType.toUpperCase()} — {target.path}
        </Text>
        <PageTargetStatusBadge status={target.status} />
        {visualDiff && (
          <Badge tone={visualDiff.mismatchPercent > 5 ? "warning" : "success"}>
            {visualDiff.mismatchPercent}% mismatch
          </Badge>
        )}
      </InlineStack>

      {target.errorMessage && (
        <Text as="p" tone="critical">{target.errorMessage}</Text>
      )}

      {target.status === "complete" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "12px",
          }}
        >
          <ScreenshotColumn
            label="Base"
            screenshot={baseScreenshot}
            onClick={handleZoom}
          />
          <ScreenshotColumn
            label="Candidate"
            screenshot={candidateScreenshot}
            onClick={handleZoom}
          />
          <DiffColumn label="Diff" visualDiff={visualDiff} onClick={handleZoom} />
        </div>
      )}

      <Divider />
    </BlockStack>
  );
}

function ScreenshotColumn({
  label,
  screenshot,
  onClick,
}: {
  label: string;
  screenshot?: ScreenshotData;
  onClick?: () => void;
}) {
  return (
    <BlockStack gap="200">
      <Text as="span" variant="bodySm" fontWeight="semibold">
        {label}
      </Text>
      {screenshot ? (
        <img
          src={`/${screenshot.filePath}`}
          alt={`${label} screenshot`}
          role="button"
          tabIndex={0}
          onClick={onClick}
          onKeyDown={(e) => { if (e.key === "Enter") onClick?.(); }}
          style={{
            width: "100%",
            border: "1px solid var(--p-color-border)",
            cursor: "pointer",
          }}
        />
      ) : (
        <Text as="p" tone="subdued">No screenshot</Text>
      )}
    </BlockStack>
  );
}

function DiffColumn({
  label,
  visualDiff,
  onClick,
}: {
  label: string;
  visualDiff?: VisualDiffData;
  onClick?: () => void;
}) {
  return (
    <BlockStack gap="200">
      <Text as="span" variant="bodySm" fontWeight="semibold">
        {label}
      </Text>
      {visualDiff ? (
        <img
          src={`/${visualDiff.diffFilePath}`}
          alt="Visual diff"
          role="button"
          tabIndex={0}
          onClick={onClick}
          onKeyDown={(e) => { if (e.key === "Enter") onClick?.(); }}
          style={{
            width: "100%",
            border: "1px solid var(--p-color-border)",
            cursor: "pointer",
          }}
        />
      ) : (
        <Text as="p" tone="subdued">No diff</Text>
      )}
    </BlockStack>
  );
}

// ── Checks Tab ───────────────────────────────────────────────────────

function ChecksTab({ pageTargets }: { pageTargets: PageTargetData[] }) {
  const allChecks = pageTargets.flatMap((target) =>
    groupChecksByName(target.checkResults).map((group) => ({
      ...group,
      pageType: target.pageType,
    })),
  );

  const regressions = allChecks.filter(
    (c) => c.basePassed && !c.candidatePassed,
  );

  return (
    <BlockStack gap="400">
      {regressions.length > 0 && (
        <Banner tone="critical">
          {regressions.length} regression{regressions.length !== 1 ? "s" : ""}{" "}
          detected — checks that passed on base but failed on candidate.
        </Banner>
      )}

      {allChecks.length > 0 ? (
        <DataTable
          columnContentTypes={["text", "text", "text", "text"]}
          headings={["Check", "Page", "Base", "Candidate"]}
          rows={allChecks.map((c) => [
            c.checkName,
            c.pageType,
            c.basePassed ? "Pass" : "Fail",
            c.candidatePassed ? "Pass" : "Fail",
          ])}
        />
      ) : (
        <Text as="p" tone="subdued">No checks ran for this diff.</Text>
      )}
    </BlockStack>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: any; label: string }> = {
    queued: { tone: "attention", label: "Queued" },
    running: { tone: "warning", label: "Running" },
    complete: { tone: "success", label: "Complete" },
    failed: { tone: "critical", label: "Failed" },
  };
  const { tone, label } = map[status] || { tone: "new", label: status };
  return <Badge tone={tone}>{label}</Badge>;
}

function PageTargetStatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: any; label: string }> = {
    pending: { tone: "attention", label: "Pending" },
    complete: { tone: "success", label: "Complete" },
    failed: { tone: "critical", label: "Failed" },
  };
  const { tone, label } = map[status] || { tone: "new", label: status };
  return <Badge tone={tone}>{label}</Badge>;
}

function SummaryChip({
  label,
  count,
  tone,
}: {
  label: string;
  count: number | string;
  tone: string;
}) {
  return (
    <Box
      padding="200"
      borderRadius="200"
      background="bg-surface-secondary"
    >
      <BlockStack gap="100" inlineAlign="center">
        <Text as="span" variant="headingLg" fontWeight="bold">
          {count}
        </Text>
        <Text as="span" variant="bodySm" tone={tone as any}>
          {label}
        </Text>
      </BlockStack>
    </Box>
  );
}

interface AssetDiffRow {
  id: string;
  key: string;
  changeType: string;
  diffText: string | null;
}

function DiffGroup({
  title,
  tone,
  diffs,
  showDiff = false,
}: {
  title: string;
  tone: string;
  diffs: AssetDiffRow[];
  showDiff?: boolean;
}) {
  return (
    <BlockStack gap="300">
      <Text as="h2" variant="headingMd">
        {title}
      </Text>
      <Divider />
      {diffs.map((diff) => (
        <DiffFileRow key={diff.id} diff={diff} showDiff={showDiff} />
      ))}
    </BlockStack>
  );
}

function DiffFileRow({
  diff,
  showDiff,
}: {
  diff: AssetDiffRow;
  showDiff: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" variant="bodyMd">
          <code>{diff.key}</code>
        </Text>
        {showDiff && diff.diffText && (
          <Button variant="plain" onClick={toggle}>
            {open ? "Hide diff" : "Show diff"}
          </Button>
        )}
        {diff.changeType.includes("skipped") && (
          <Badge tone="info">{diff.changeType}</Badge>
        )}
      </InlineStack>

      {showDiff && diff.diffText && (
        <Collapsible open={open} id={`diff-${diff.id}`}>
          <Box padding="300" background="bg-surface-secondary" borderRadius="200">
            <pre
              style={{
                fontFamily: "monospace",
                fontSize: "12px",
                lineHeight: "1.5",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                margin: 0,
                maxHeight: "500px",
                overflow: "auto",
              }}
            >
              {diff.diffText}
            </pre>
          </Box>
        </Collapsible>
      )}
    </BlockStack>
  );
}

// ── Screenshot Zoom Modal ────────────────────────────────────────────

function ScreenshotZoomModal({
  target,
  onClose,
}: {
  target: PageTargetData | null;
  onClose: () => void;
}) {
  const [activeView, setActiveView] = useState(0);

  if (!target) return null;

  const baseScreenshot = target.screenshots.find((s) => s.variant === "base");
  const candidateScreenshot = target.screenshots.find((s) => s.variant === "candidate");
  const visualDiff = target.visualDiffs[0];

  const mismatchLabel = visualDiff
    ? `${visualDiff.mismatchPercent}% mismatch`
    : "";

  const views = [
    { id: "base", content: "Base" },
    { id: "candidate", content: "Candidate" },
    { id: "diff", content: "Diff" },
  ];

  const imageSrc =
    activeView === 0
      ? baseScreenshot ? `/${baseScreenshot.filePath}` : null
      : activeView === 1
        ? candidateScreenshot ? `/${candidateScreenshot.filePath}` : null
        : visualDiff ? `/${visualDiff.diffFilePath}` : null;

  const imageAlt =
    activeView === 0 ? "Base screenshot"
      : activeView === 1 ? "Candidate screenshot"
        : "Visual diff";

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`${target.pageType.toUpperCase()} — ${target.path}${mismatchLabel ? ` (${mismatchLabel})` : ""}`}
      size="large"
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Tabs tabs={views} selected={activeView} onSelect={setActiveView} />
          <div style={{ overflow: "auto", maxHeight: "75vh" }}>
            {imageSrc ? (
              <img
                src={imageSrc}
                alt={imageAlt}
                style={{
                  width: "100%",
                  display: "block",
                  border: "1px solid var(--p-color-border)",
                }}
              />
            ) : (
              <Text as="p" tone="subdued">No image available</Text>
            )}
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Types ────────────────────────────────────────────────────────────

interface ScreenshotData {
  id: string;
  variant: string;
  filePath: string;
  width: number;
  height: number;
}

interface VisualDiffData {
  id: string;
  diffFilePath: string;
  mismatchCount: number;
  mismatchPercent: number;
  totalPixels: number;
  effectivePixels: number;
}

interface CheckResultData {
  id: string;
  checkName: string;
  variant: string;
  passed: boolean;
  selector: string;
  detail: string | null;
}

interface PageTargetData {
  id: string;
  pageType: string;
  path: string;
  handle: string | null;
  status: string;
  errorMessage: string | null;
  screenshots: ScreenshotData[];
  visualDiffs: VisualDiffData[];
  checkResults: CheckResultData[];
  interactiveTests?: InteractiveTestData[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function groupByChangeType(diffs: AssetDiffRow[]) {
  const groups = {
    added: [] as AssetDiffRow[],
    removed: [] as AssetDiffRow[],
    modified: [] as AssetDiffRow[],
    skipped: [] as AssetDiffRow[],
  };

  for (const d of diffs) {
    switch (d.changeType) {
      case "added":
        groups.added.push(d);
        break;
      case "removed":
        groups.removed.push(d);
        break;
      case "modified":
        groups.modified.push(d);
        break;
      default:
        groups.skipped.push(d);
    }
  }

  return groups;
}

function groupChecksByName(checks: CheckResultData[]) {
  const map = new Map<
    string,
    { checkName: string; basePassed: boolean; candidatePassed: boolean }
  >();

  for (const c of checks) {
    if (!map.has(c.checkName)) {
      map.set(c.checkName, {
        checkName: c.checkName,
        basePassed: false,
        candidatePassed: false,
      });
    }
    const entry = map.get(c.checkName)!;
    if (c.variant === "base") entry.basePassed = c.passed;
    if (c.variant === "candidate") entry.candidatePassed = c.passed;
  }

  return Array.from(map.values());
}

// ── Flows Tab ────────────────────────────────────────────────────────

interface InteractiveTestData {
  id: string;
  testName: string;
  variant: string;
  status: string;
  errorMessage: string | null;
  totalSteps: number;
  completedSteps: number;
  steps: InteractiveStepData[];
}

interface InteractiveStepData {
  id: string;
  stepNumber: number;
  action: string;
  status: string;
  selector: string | null;
  screenshotPath: string | null;
  errorDetail: string | null;
  durationMs: number | null;
}

interface GroupedFlowTest {
  testName: string;
  pageType: string;
  path: string;
  baseStatus: string | null;
  candidateStatus: string | null;
  baseSteps: InteractiveStepData[];
  candidateSteps: InteractiveStepData[];
}

function FlowsTab({ pageTargets }: { pageTargets: PageTargetData[] }) {
  const allTests = pageTargets.flatMap(target =>
    groupTestsByName(target.interactiveTests || [], target.pageType, target.path)
  );

  const regressions = allTests.filter(
    t => t.baseStatus === "passed" && t.candidateStatus !== "passed"
  );

  if (allTests.length === 0) {
    return (
      <BlockStack gap="400">
        <Banner>
          <p>No interactive tests were run for this diff. Enable interactive tests in Settings to validate user flows.</p>
        </Banner>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="400">
      {regressions.length > 0 && (
        <Banner tone="critical">
          <p><strong>{regressions.length} flow regression(s) detected:</strong> The candidate theme has user interaction issues that the base theme doesn't have.</p>
        </Banner>
      )}

      {allTests.map((test, idx) => (
        <FlowTestCard key={idx} test={test} />
      ))}
    </BlockStack>
  );
}

function FlowTestCard({ test }: { test: GroupedFlowTest }) {
  const [expanded, setExpanded] = useState(false);

  const isRegression = test.baseStatus === "passed" && test.candidateStatus !== "passed";

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <Text variant="headingMd" as="h3">{formatTestName(test.testName)}</Text>
            <Text variant="bodySm" tone="subdued">
              {test.pageType} · {test.path}
            </Text>
          </BlockStack>
          <InlineStack gap="200">
            <Badge tone={getStatusTone(test.baseStatus)}>
              Base: {test.baseStatus || "not run"}
            </Badge>
            <Badge tone={getStatusTone(test.candidateStatus)}>
              Candidate: {test.candidateStatus || "not run"}
            </Badge>
          </InlineStack>
        </InlineStack>

        {isRegression && (
          <Banner tone="critical">
            Regression: This flow passed on the base theme but failed on the candidate theme.
          </Banner>
        )}

        <Button onClick={() => setExpanded(!expanded)} variant="plain">
          {expanded ? "Hide steps" : "Show steps"}
        </Button>

        <Collapsible open={expanded} id={`flow-${test.testName}`}>
          <BlockStack gap="400">
            <Divider />

            <BlockStack gap="300">
              <Text variant="headingSm" as="h4">Base Theme</Text>
              <FlowStepTimeline steps={test.baseSteps} />
            </BlockStack>

            <Divider />

            <BlockStack gap="300">
              <Text variant="headingSm" as="h4">Candidate Theme</Text>
              <FlowStepTimeline steps={test.candidateSteps} />
            </BlockStack>
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}

function FlowStepTimeline({ steps }: { steps: InteractiveStepData[] }) {
  const [zoomedScreenshot, setZoomedScreenshot] = useState<string | null>(null);

  if (steps.length === 0) {
    return <Text tone="subdued">No steps recorded</Text>;
  }

  return (
    <>
      <BlockStack gap="300">
        {steps.map((step) => (
          <InlineStack key={step.id} gap="300" blockAlign="start">
            <Box
              minWidth="40px"
              padding="200"
              borderRadius="full"
              background={
                step.status === "success"
                  ? "bg-fill-success"
                  : step.status === "skipped"
                  ? "bg-fill-info-secondary"
                  : "bg-fill-critical"
              }
            >
              <Text
                variant="bodyMd"
                fontWeight="semibold"
                alignment="center"
                tone={step.status === "success" ? "success" : step.status === "skipped" ? "base" : "critical"}
              >
                {step.stepNumber}
              </Text>
            </Box>

            <BlockStack gap="200" inlineAlign="start">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="bodyMd">{formatAction(step.action)}</Text>
                {step.durationMs && (
                  <Badge tone="info">{step.durationMs}ms</Badge>
                )}
              </InlineStack>

              {step.status === "skipped" && (
                <Text variant="bodySm" tone="subdued">
                  Skipped (optional step)
                </Text>
              )}

              {step.errorDetail && (
                <Banner tone="critical">
                  <p style={{ fontSize: "0.875rem" }}>{step.errorDetail}</p>
                </Banner>
              )}

              {step.screenshotPath && (
                <Box>
                  <img
                    src={`/${step.screenshotPath}`}
                    alt={`Step ${step.stepNumber}`}
                    style={{
                      maxWidth: "400px",
                      border: "1px solid var(--p-border)",
                      borderRadius: "8px",
                      cursor: "pointer",
                    }}
                    onClick={() => setZoomedScreenshot(step.screenshotPath)}
                  />
                </Box>
              )}

              {step.selector && (
                <Text variant="bodySm" tone="subdued">
                  Selector: <code>{step.selector}</code>
                </Text>
              )}
            </BlockStack>
          </InlineStack>
        ))}
      </BlockStack>

      {zoomedScreenshot && (
        <Modal
          open={!!zoomedScreenshot}
          onClose={() => setZoomedScreenshot(null)}
          title="Screenshot"
          large
        >
          <Modal.Section>
            <img
              src={`/${zoomedScreenshot}`}
              alt="Screenshot"
              style={{ width: "100%", height: "auto" }}
            />
          </Modal.Section>
        </Modal>
      )}
    </>
  );
}

function groupTestsByName(
  tests: InteractiveTestData[],
  pageType: string,
  path: string
): GroupedFlowTest[] {
  const grouped = new Map<string, GroupedFlowTest>();

  for (const test of tests) {
    if (!grouped.has(test.testName)) {
      grouped.set(test.testName, {
        testName: test.testName,
        pageType,
        path,
        baseStatus: null,
        candidateStatus: null,
        baseSteps: [],
        candidateSteps: [],
      });
    }

    const group = grouped.get(test.testName)!;
    if (test.variant === "base") {
      group.baseStatus = test.status;
      group.baseSteps = test.steps;
    } else {
      group.candidateStatus = test.status;
      group.candidateSteps = test.steps;
    }
  }

  return Array.from(grouped.values());
}

function formatTestName(testName: string): string {
  return testName
    .split("_")
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function formatAction(action: string): string {
  return action
    .replace(/_/g, " ")
    .replace(/\b\w/g, char => char.toUpperCase());
}

function getStatusTone(status: string | null): "success" | "critical" | "warning" | "info" {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "error":
      return "critical";
    case "partial":
      return "warning";
    default:
      return "info";
  }
}

// ── Error Boundary ──────────────────────────────────────────────────

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  let message = "Something went wrong loading this diff run.";
  if (isRouteErrorResponse(error)) {
    message = `${error.status}: ${error.statusText || error.data}`;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <Page
      title="Error"
      backAction={{ content: "Back", onAction: () => navigate("/app/diff") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd" tone="critical">
                Failed to load diff run
              </Text>
              <Text as="p" variant="bodyMd">
                {message}
              </Text>
              <Button onClick={() => navigate("/app/diff")}>
                Back to Theme Diff
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
