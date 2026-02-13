import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "~/shopify.server";
import { notify } from "~/components/Notification";
import { listThemes } from "~/lib/shopify-api.server";
import { enqueueDiffJob } from "~/lib/queue.server";
import prisma from "~/db.server";

// ── Loader: fetch themes ─────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const themes = await listThemes(session.shop, session.accessToken!);

  // Also fetch recent diff runs for this shop
  const recentRuns = await prisma.diffRun.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      baseThemeName: true,
      candidateThemeName: true,
      status: true,
      createdAt: true,
      summary: true,
    },
  });

  return json({ themes, recentRuns });
};

// ── Action: create DiffRun & enqueue ─────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent");

  // ── Delete run ──
  if (intent === "delete") {
    const runId = formData.get("runId") as string;
    if (runId) {
      // Clean up screenshot files on disk
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const runDir = join("public", "runs", runId);
      await rm(runDir, { recursive: true, force: true }).catch(() => {});

      await prisma.diffRun.delete({ where: { id: runId } });
    }
    return json({ deleted: true });
  }

  // ── Create run ──
  const baseThemeId = formData.get("baseThemeId");
  const candidateThemeId = formData.get("candidateThemeId");
  const baseThemeName = formData.get("baseThemeName") as string;
  const candidateThemeName = formData.get("candidateThemeName") as string;

  if (!baseThemeId || !candidateThemeId) {
    return json(
      { error: "Please select both a base and candidate theme." },
      { status: 400 }
    );
  }

  if (baseThemeId === candidateThemeId) {
    return json(
      { error: "Base and candidate themes must be different." },
      { status: 400 }
    );
  }

  const diffRun = await prisma.diffRun.create({
    data: {
      shopDomain: session.shop,
      baseThemeId: BigInt(baseThemeId as string),
      baseThemeName: baseThemeName || "Base",
      candidateThemeId: BigInt(candidateThemeId as string),
      candidateThemeName: candidateThemeName || "Candidate",
      status: "queued",
    },
  });

  await enqueueDiffJob(diffRun.id);

  return redirect(`/app/diff/${diffRun.id}`);
};

// ── Component ────────────────────────────────────────────────────────

export default function DiffPage() {
  const { themes, recentRuns } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSubmitting = navigation.state === "submitting";

  // Track which runs are in-progress so we can detect completions
  const hasActiveRuns = recentRuns.some(
    (r: any) => r.status === "queued" || r.status === "running",
  );

  // Poll every 3s while any run is queued or running
  useEffect(() => {
    if (!hasActiveRuns) return;
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [hasActiveRuns, revalidator]);

  // Toast when a run finishes (transitions out of queued/running)
  const prevActiveIdsRef = useRef<Set<string>>(
    new Set(
      recentRuns
        .filter((r: any) => r.status === "queued" || r.status === "running")
        .map((r: any) => r.id),
    ),
  );
  useEffect(() => {
    const currentActiveIds = new Set(
      recentRuns
        .filter((r: any) => r.status === "queued" || r.status === "running")
        .map((r: any) => r.id),
    );

    // Check if any previously-active run is no longer active
    for (const id of prevActiveIdsRef.current) {
      if (!currentActiveIds.has(id)) {
        const run = recentRuns.find((r: any) => r.id === id);
        if (run) {
          const label = `${run.baseThemeName} → ${run.candidateThemeName}`;
          if (run.status === "complete") {
            notify(`Diff complete: ${label}`);
          } else if (run.status === "failed") {
            notify(`Diff failed: ${label}`, { tone: "error" });
          }
        }
      }
    }

    prevActiveIdsRef.current = currentActiveIds;
  }, [recentRuns]);

  // Find the main theme to set as default base
  const mainTheme = themes.find((t: any) => t.role === "main");

  const [baseThemeId, setBaseThemeId] = useState<string>(
    mainTheme ? String(mainTheme.id) : ""
  );
  const [candidateThemeId, setCandidateThemeId] = useState<string>("");

  const themeOptions = themes.map((t: any) => ({
    label: `${t.name} (${t.role})`,
    value: String(t.id),
  }));

  const selectedBase = themes.find(
    (t: any) => String(t.id) === baseThemeId
  );
  const selectedCandidate = themes.find(
    (t: any) => String(t.id) === candidateThemeId
  );

  return (
    <Page title="Theme Diff">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Compare two themes
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Select a base theme and a candidate theme to compare their
                assets. The diff will run in the background.
              </Text>

              {(actionData as any)?.error && (
                <Banner tone="critical">
                  <p>{(actionData as any).error}</p>
                </Banner>
              )}

              <Form method="post">
                <BlockStack gap="400">
                  <Select
                    label="Base theme"
                    options={[
                      { label: "-- Select base theme --", value: "" },
                      ...themeOptions,
                    ]}
                    value={baseThemeId}
                    onChange={setBaseThemeId}
                  />

                  <Select
                    label="Candidate theme"
                    options={[
                      { label: "-- Select candidate theme --", value: "" },
                      ...themeOptions,
                    ]}
                    value={candidateThemeId}
                    onChange={setCandidateThemeId}
                  />

                  {/* Hidden fields to pass theme names */}
                  <input type="hidden" name="baseThemeId" value={baseThemeId} />
                  <input
                    type="hidden"
                    name="candidateThemeId"
                    value={candidateThemeId}
                  />
                  <input
                    type="hidden"
                    name="baseThemeName"
                    value={selectedBase?.name || ""}
                  />
                  <input
                    type="hidden"
                    name="candidateThemeName"
                    value={selectedCandidate?.name || ""}
                  />

                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      submit
                      loading={isSubmitting}
                      disabled={!baseThemeId || !candidateThemeId}
                    >
                      Run Diff
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Recent runs */}
        {recentRuns.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recent diff runs
                </Text>
                {recentRuns.map((run: any) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

function RunRow({ run }: { run: any }) {
  const fetcher = useFetcher();
  const isDeleting = fetcher.state !== "idle";
  const [showConfirm, setShowConfirm] = useState(false);

  const openConfirm = useCallback(() => setShowConfirm(true), []);
  const closeConfirm = useCallback(() => setShowConfirm(false), []);

  const handleDelete = useCallback(() => {
    fetcher.submit(
      { intent: "delete", runId: run.id },
      { method: "post" },
    );
    setShowConfirm(false);
  }, [fetcher, run.id]);

  // Show toast when delete succeeds
  useEffect(() => {
    if ((fetcher.data as any)?.deleted) {
      notify("Run deleted");
    }
  }, [fetcher.data]);

  return (
    <>
      <Card key={run.id}>
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {run.baseThemeName} → {run.candidateThemeName}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {new Date(run.createdAt).toLocaleString()} —{" "}
              <StatusLabel status={run.status} />
            </Text>
          </BlockStack>
          <InlineStack gap="200">
            <Link to={`/app/diff/${run.id}`}>View</Link>
            <Button
              variant="plain"
              tone="critical"
              onClick={openConfirm}
              loading={isDeleting}
            >
              Delete
            </Button>
          </InlineStack>
        </InlineStack>
      </Card>

      <Modal
        open={showConfirm}
        onClose={closeConfirm}
        title="Delete diff run?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: handleDelete,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: closeConfirm,
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            Are you sure you want to delete the diff run{" "}
            <strong>{run.baseThemeName} → {run.candidateThemeName}</strong>?
            This will permanently remove all screenshots and results.
          </Text>
        </Modal.Section>
      </Modal>
    </>
  );
}

function StatusLabel({ status }: { status: string }) {
  const toneMap: Record<string, string> = {
    queued: "subdued",
    running: "caution",
    complete: "success",
    failed: "critical",
  };
  return (
    <Text as="span" tone={toneMap[status] as any || "subdued"}>
      {status}
    </Text>
  );
}
