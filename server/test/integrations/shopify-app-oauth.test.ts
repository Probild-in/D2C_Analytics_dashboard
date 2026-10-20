import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getShopifyAppInstallUrl, exchangeShopifyAppCode, getShopInfo } from "../../src/integrations/shopify-app-oauth.js";

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map((key) => `${key}=${rest[key]}`).join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

beforeEach(() => {
  process.env.SHOPIFY_APP_STORE_CLIENT_ID = "test-app-store-client-id";
  process.env.SHOPIFY_APP_STORE_CLIENT_SECRET = "test-app-store-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getShopifyAppInstallUrl", () => {
  it("builds Shopify's authorize URL with this app's own client id", () => {
    const url = getShopifyAppInstallUrl("abc-fashion.myshopify.com", "signed-state");
    expect(url).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
    expect(url).toContain("client_id=test-app-store-client-id");
    expect(url).toContain("state=signed-state");
  });
});

describe("exchangeShopifyAppCode", () => {
  it("verifies the HMAC, exchanges the code, and returns the shop + access token", async () => {
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state: "x", timestamp: "123" };
    const hmac = computeTestHmac(query, "test-app-store-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_appstore_token" }), { status: 200 })),
    );
    const result = await exchangeShopifyAppCode({ ...query, hmac });
    expect(result).toEqual({ shop: "abc-fashion.myshopify.com", accessToken: "shpat_appstore_token" });
  });

  it("throws on a bad HMAC", async () => {
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state: "x", hmac: "0".repeat(64) };
    await expect(exchangeShopifyAppCode(query)).rejects.toThrow(/HMAC/);
  });

  it("throws when shop or code is missing", async () => {
    await expect(exchangeShopifyAppCode({ hmac: "x" })).rejects.toThrow(/shop or code/);
  });
});

describe("getShopInfo", () => {
  it("fetches the shop's own contact email and name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://abc-fashion.myshopify.com/admin/api/2024-10/shop.json");
        return new Response(JSON.stringify({ shop: { email: "owner@newbrand.com", name: "New Brand Co" } }), { status: 200 });
      }),
    );
    const info = await getShopInfo("abc-fashion.myshopify.com", "shpat_token");
    expect(info).toEqual({ email: "owner@newbrand.com", name: "New Brand Co" });
  });
});
