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
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  Divider,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Spinner,
  Text,
} from "@shopify/polaris";
import { useCallback, useEffect, useState } from "react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

// ── Loader ───────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  console.log("[diff-detail] Loading diff run:", params.diffRunId);
  await authenticate.admin(request);
  console.log("[diff-detail] Auth passed");

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
    },
  });

  console.log("[diff-detail] DiffRun found:", !!diffRun, diffRun?.status);

  if (!diffRun) {
    throw new Response("DiffRun not found", { status: 404 });
  }

  // Serialize BigInts to strings for JSON transport
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

  const isInProgress =
    diffRun.status === "queued" || diffRun.status === "running";

  // Auto-refresh while job is in progress
  useEffect(() => {
    if (!isInProgress) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 2000);
    return () => clearInterval(interval);
  }, [isInProgress, revalidator]);

  // Group diffs by changeType
  const grouped = groupByChangeType(diffRun.assetDiffs);
  const summary = (diffRun.summary as any) || {};

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
                <InlineStack gap="400">
                  <SummaryChip label="Added" count={summary.added || 0} tone="success" />
                  <SummaryChip label="Removed" count={summary.removed || 0} tone="critical" />
                  <SummaryChip label="Modified" count={summary.modified || 0} tone="caution" />
                  <SummaryChip label="Skipped" count={summary.skipped || 0} tone="subdued" />
                </InlineStack>
              )}

              {isInProgress && (
                <ProgressBar progress={diffRun.status === "running" ? 50 : 10} size="small" />
              )}

              {/*
                TODO: Visual Diff Placeholder
                ─────────────────────────────
                Future enhancement: Add screenshot comparison for visual diffs.
                Steps:
                1. Capture screenshots of both themes using a headless browser
                   (e.g. Puppeteer with Shopify theme preview URLs).
                2. Store screenshots in S3 or similar object storage.
                3. Use a pixel-diff library (e.g. pixelmatch) to generate diff images.
                4. Display side-by-side or overlay comparison in a new tab/section.
                5. Add "Visual Diff" toggle button here.
              */}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* File lists by change type */}
        {diffRun.status === "complete" && (
          <>
            {grouped.added.length > 0 && (
              <Layout.Section>
                <DiffGroup
                  title={`Added (${grouped.added.length})`}
                  tone="success"
                  diffs={grouped.added}
                />
              </Layout.Section>
            )}

            {grouped.removed.length > 0 && (
              <Layout.Section>
                <DiffGroup
                  title={`Removed (${grouped.removed.length})`}
                  tone="critical"
                  diffs={grouped.removed}
                />
              </Layout.Section>
            )}

            {grouped.modified.length > 0 && (
              <Layout.Section>
                <DiffGroup
                  title={`Modified (${grouped.modified.length})`}
                  tone="warning"
                  diffs={grouped.modified}
                  showDiff
                />
              </Layout.Section>
            )}

            {grouped.skipped.length > 0 && (
              <Layout.Section>
                <DiffGroup
                  title={`Skipped (${grouped.skipped.length})`}
                  tone="info"
                  diffs={grouped.skipped}
                />
              </Layout.Section>
            )}
          </>
        )}
      </Layout>
    </Page>
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

function SummaryChip({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
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
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        <Divider />
        {diffs.map((diff) => (
          <DiffFileRow key={diff.id} diff={diff} showDiff={showDiff} />
        ))}
      </BlockStack>
    </Card>
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
        // binary-skipped, large-file-skipped
        groups.skipped.push(d);
    }
  }

  return groups;
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
