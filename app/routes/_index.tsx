import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Authenticate HERE at "/" where Shopify sends all params (shop, host,
  // embedded, id_token). The CLI proxy drops query-strings on redirects,
  // so auth must happen before we redirect to /app.
  await authenticate.admin(request);

  // After auth succeeds the session is in the DB. Forward only the params
  // the library needs for subsequent validate-shop-and-host checks.
  const shop = url.searchParams.get("shop") || "";
  const host = url.searchParams.get("host") || "";
  return redirect(`/app?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(host)}&embedded=1`);
};

// The boundary helpers let App Bridge handle redirects that can't happen
// inside the embedded iframe (e.g. OAuth / managed-install).
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
