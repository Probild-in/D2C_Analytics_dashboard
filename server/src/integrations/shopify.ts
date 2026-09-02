import type { Connector } from "./types.js";

const SHOPIFY_SCOPES = "read_orders,read_products,read_customers";

function getRedirectUri(): string {
  const frontendApiUrl = process.env.PUBLIC_API_URL;
  if (!frontendApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${frontendApiUrl}/api/integrations/shopify/callback`;
}

function getCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("SHOPIFY_API_KEY and SHOPIFY_API_SECRET environment variables must be set");
  }
  return { apiKey, apiSecret };
}

export const shopifyConnector: Connector = {
  platform: "shopify",

  getAuthUrl(shopDomain: string, state: string): string {
    const { apiKey } = getCredentials();
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set("client_id", apiKey);
    url.searchParams.set("scope", SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>) {
    const shop = query.shop;
    const code = query.code;
    if (!shop || !code) {
      throw new Error("Shopify callback missing shop or code query parameter");
    }
    const { apiKey, apiSecret } = getCredentials();
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) {
      throw new Error(`Shopify token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string };
    return { externalAccountId: shop, accessToken: body.access_token };
  },

  async sync(_connectionId: string) {
    throw new Error("not implemented yet — see Task 5");
  },

  async disconnect(_connectionId: string) {
    throw new Error("not implemented yet — see Task 5");
  },
};
