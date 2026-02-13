import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useState } from "react";
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
  });
};

// ── Action ───────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const formData = await request.formData();
  const storefrontPassword = (formData.get("storefrontPassword") as string) || "";
  const hideSelectors = (formData.get("hideSelectors") as string) || "";

  await prisma.shopSetting.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      storefrontPassword: storefrontPassword || null,
      hideSelectors: hideSelectors || null,
    },
    update: {
      storefrontPassword: storefrontPassword || null,
      hideSelectors: hideSelectors || null,
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
  const [hideSelectors, setHideSelectors] = useState(
    loaderData.hideSelectors,
  );

  const isSaving = navigation.state === "submitting";

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.set("storefrontPassword", storefrontPassword);
    formData.set("hideSelectors", hideSelectors);
    submit(formData, { method: "post" });
  }, [storefrontPassword, hideSelectors, submit]);

  return (
    <Page title="Settings">
      <Layout>
        {actionData?.success && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => {}}>
              Settings saved successfully.
            </Banner>
          </Layout.Section>
        )}

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
                helpText="CSS selectors to hide during screenshots (one per line). Useful for hiding dynamic content like chat widgets or banners."
                autoComplete="off"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Button variant="primary" onClick={handleSave} loading={isSaving}>
            Save
          </Button>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
