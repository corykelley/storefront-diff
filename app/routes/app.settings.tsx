import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

// ── Loader ───────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const settings = await prisma.shopSetting.findUnique({
    where: { shopDomain },
  });

  return json({
    storefrontPassword: settings?.storefrontPassword ?? "",
    hideSelectors: settings?.hideSelectors ?? "",
    customUrls: settings?.customUrls ?? "",
    navSelector: settings?.navSelector ?? "",
    interactiveTestsEnabled: settings?.interactiveTestsEnabled ?? false,
  });
};

// ── Action ───────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const storefrontPassword =
    (formData.get("storefrontPassword") as string) || "";
  const hideSelectors = (formData.get("hideSelectors") as string) || "";
  const customUrls = (formData.get("customUrls") as string) || "";
  const navSelector = (formData.get("navSelector") as string) || "";
  const interactiveTestsEnabled =
    formData.get("interactiveTestsEnabled") === "true";

  await prisma.shopSetting.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      storefrontPassword: storefrontPassword || null,
      hideSelectors: hideSelectors || null,
      customUrls: customUrls || null,
      navSelector: navSelector || null,
      interactiveTestsEnabled,
    },
    update: {
      storefrontPassword: storefrontPassword || null,
      hideSelectors: hideSelectors || null,
      customUrls: customUrls || null,
      navSelector: navSelector || null,
      interactiveTestsEnabled,
    },
  });

  return json({ success: true });
};

// ── Component ────────────────────────────────────────────────────────

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [storefrontPassword, setStorefrontPassword] = useState(
    loaderData.storefrontPassword,
  );
  const [hideSelectors, setHideSelectors] = useState(loaderData.hideSelectors);
  const [customUrls, setCustomUrls] = useState(loaderData.customUrls);
  const [navSelector, setNavSelector] = useState(loaderData.navSelector);
  const [interactiveTestsEnabled, setInteractiveTestsEnabled] = useState(
    loaderData.interactiveTestsEnabled,
  );
  const [savedRecently, setSavedRecently] = useState(false);

  const isSaving = navigation.state === "submitting";
  const wasSaving =
    navigation.state === "loading" && navigation.formData != null;

  const isDirty =
    storefrontPassword !== loaderData.storefrontPassword ||
    hideSelectors !== loaderData.hideSelectors ||
    customUrls !== loaderData.customUrls ||
    navSelector !== loaderData.navSelector ||
    interactiveTestsEnabled !== loaderData.interactiveTestsEnabled;

  // Sync local state with loader data after a save completes
  useEffect(() => {
    setStorefrontPassword(loaderData.storefrontPassword);
    setHideSelectors(loaderData.hideSelectors);
    setCustomUrls(loaderData.customUrls);
    setNavSelector(loaderData.navSelector);
    setInteractiveTestsEnabled(loaderData.interactiveTestsEnabled);
  }, [loaderData]);

  // Show "Saved" feedback briefly after a successful save
  useEffect(() => {
    if (actionData?.success) {
      setSavedRecently(true);
      const timer = setTimeout(() => setSavedRecently(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [actionData]);

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.set("storefrontPassword", storefrontPassword);
    formData.set("hideSelectors", hideSelectors);
    formData.set("customUrls", customUrls);
    formData.set("navSelector", navSelector);
    formData.set("interactiveTestsEnabled", String(interactiveTestsEnabled));
    submit(formData, { method: "post" });
  }, [
    storefrontPassword,
    hideSelectors,
    customUrls,
    navSelector,
    interactiveTestsEnabled,
    submit,
  ]);

  return (
    <Page title="Settings">
      <Box paddingBlockEnd="800">
        <Layout>
          <Layout.Section>
            <Banner tone="info">
              <p>
                <strong>Tip:</strong> If cookie consent banners, chat widgets,
                or other popups are interfering with screenshots or interactive
                tests, add their CSS selectors to the{" "}
                <strong>Hide selectors</strong> field above (e.g.{" "}
                <code>#shopify-pc__banner</code>, <code>.cookie-consent</code>).
              </p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Storefront Access
                </Text>
                <TextField
                  label="Storefront password"
                  type="password"
                  value={storefrontPassword}
                  onChange={setStorefrontPassword}
                  helpText="If your store is password-protected, enter the password here so screenshots can access the actual pages."
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Screenshot Configuration
                </Text>
                <TextField
                  label="Hide selectors"
                  value={hideSelectors}
                  onChange={setHideSelectors}
                  multiline={4}
                  helpText="CSS selectors to hide during screenshots and interactive tests (one per line). Useful for hiding dynamic content like chat widgets, cookie banners, or newsletter popups."
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Custom Pages
                </Text>
                <TextField
                  label="Custom URLs"
                  value={customUrls}
                  onChange={setCustomUrls}
                  multiline={4}
                  helpText="Additional pages to include in visual diffs (one path per line, e.g. /pages/about or /blogs/news)."
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Navigation Selector
                </Text>
                <TextField
                  label="Navigation selector"
                  value={navSelector}
                  onChange={setNavSelector}
                  multiline={false}
                  helpText="CSS selector to identify navigation element."
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Interactive Tests
                </Text>
                <Checkbox
                  label="Enable interactive tests"
                  checked={interactiveTestsEnabled}
                  onChange={setInteractiveTestsEnabled}
                  helpText="Run automated tests for user flows (buy flow, navigation, mobile menu). Adds ~30-60 seconds to diff processing."
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineStack gap="300" blockAlign="center">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={isSaving}
                disabled={!isDirty && !isSaving}
              >
                Save
              </Button>
              {savedRecently && !isDirty && (
                <Text as="span" tone="success" variant="bodySm">
                  Settings saved
                </Text>
              )}
            </InlineStack>
          </Layout.Section>
        </Layout>
      </Box>
    </Page>
  );
}
