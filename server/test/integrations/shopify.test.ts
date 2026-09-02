import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shopifyConnector } from "../../src/integrations/shopify.js";

beforeEach(() => {
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shopifyConnector.getAuthUrl", () => {
  it("builds a per-shop authorize URL with the requested scopes", () => {
    const url = shopifyConnector.getAuthUrl("test-shop.myshopify.com", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://test-shop.myshopify.com");
    expect(parsed.pathname).toBe("/admin/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("test-api-key");
    expect(parsed.searchParams.get("scope")).toBe("read_orders,read_products,read_customers");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/shopify/callback");
  });
});

describe("shopifyConnector.handleCallback", () => {
  it("exchanges the code for an access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://test-shop.myshopify.com/admin/oauth/access_token");
        return new Response(JSON.stringify({ access_token: "shpat_real_token", scope: "read_orders,read_products,read_customers" }), { status: 200 });
      }),
    );
    const result = await shopifyConnector.handleCallback({ shop: "test-shop.myshopify.com", code: "auth-code-123" });
    expect(result).toEqual({ externalAccountId: "test-shop.myshopify.com", accessToken: "shpat_real_token" });
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid request", { status: 400 })));
    await expect(shopifyConnector.handleCallback({ shop: "test-shop.myshopify.com", code: "bad-code" })).rejects.toThrow();
  });

  it("throws if the shop query param is missing", async () => {
    await expect(shopifyConnector.handleCallback({ code: "auth-code-123" })).rejects.toThrow();
  });
});
