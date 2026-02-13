import "@shopify/shopify-app-remix/server/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "~/db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  appUrl: process.env.SHOPIFY_APP_URL || "",
  scopes: (process.env.SCOPES || "read_themes").split(","),
  apiVersion: ApiVersion.October24,
  distribution: AppDistribution.AppStore,
  sessionStorage: new PrismaSessionStorage(prisma),
  isEmbeddedApp: true,
  hooks: {
    afterAuth: async ({ session }) => {
      // Persist shop + token for worker access
      await prisma.shop.upsert({
        where: { shopDomain: session.shop },
        update: { accessToken: session.accessToken! },
        create: {
          shopDomain: session.shop,
          accessToken: session.accessToken!,
        },
      });
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October24;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
