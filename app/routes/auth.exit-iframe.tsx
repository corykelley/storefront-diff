import type { LoaderFunctionArgs } from "@remix-run/node";

/**
 * This route handles the "exit iframe" flow for embedded app OAuth.
 *
 * When the app is loaded inside the Shopify Admin iframe and needs to
 * start OAuth, the library redirects here. This page renders a small
 * script that navigates the TOP-LEVEL window (not the iframe) to the
 * OAuth URL, breaking out of the iframe so OAuth can proceed.
 *
 * IMPORTANT: This route must NOT call authenticate.admin() or it will
 * loop back to itself.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const exitIframe = url.searchParams.get("exitIframe") || "/auth";
  const host = url.searchParams.get("host") || "";

  // Safely embed values in JavaScript using JSON.stringify to prevent XSS
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <script>
      var target = new URL(
        ${JSON.stringify(exitIframe)},
        window.location.origin
      ).toString();
      // Navigate the top-level window out of the iframe
      if (window.top) {
        window.top.location.href = target;
      } else {
        window.location.href = target;
      }
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
