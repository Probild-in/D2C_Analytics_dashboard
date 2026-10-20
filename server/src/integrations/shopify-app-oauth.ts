import crypto from "node:crypto";
import { normalizeShopDomain } from "../lib/shop-domain.js";

const SHOPIFY_APP_SCOPES = "read_orders,read_products,read_customers";

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.SHOPIFY_APP_STORE_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_STORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_APP_STORE_CLIENT_ID and SHOPIFY_APP_STORE_CLIENT_SECRET environment variables must be set");
  }
  return { clientId, clientSecret };
}

function getRedirectUri(): string {
  const apiUrl = process.env.PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${apiUrl}/api/shopify-app/callback`;
}

export function getShopifyAppInstallUrl(shop: string, state: string): string {
  const { clientId } = getCredentials();
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SHOPIFY_APP_SCOPES);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

function verifyCallbackHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map((key) => `${key}=${rest[key]}`).join("&");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(hmac, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export async function exchangeShopifyAppCode(query: Record<string, string>): Promise<{ shop: string; accessToken: string }> {
  const shop = query.shop;
  const code = query.code;
  if (!shop || !code) {
    throw new Error("Shopify callback missing shop or code query parameter");
  }
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    throw new Error("Shopify callback shop parameter is not a valid *.myshopify.com domain");
  }
  const { clientId, clientSecret } = getCredentials();
  if (!verifyCallbackHmac(query, clientSecret)) {
    throw new Error("Shopify App Store callback failed HMAC verification");
  }
  const res = await fetch(`https://${normalizedShop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) {
    throw new Error(`Shopify App Store token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string };
  return { shop: normalizedShop, accessToken: body.access_token };
}

export async function getShopInfo(shop: string, accessToken: string): Promise<{ email: string; name: string }> {
  const res = await fetch(`https://${shop}/admin/api/2024-10/shop.json`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch shop info: ${res.status}`);
  }
  const body = (await res.json()) as { shop: { email: string; name: string } };
  return { email: body.shop.email, name: body.shop.name };
}
