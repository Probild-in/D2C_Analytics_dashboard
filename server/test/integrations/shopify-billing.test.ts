import { describe, it, expect, vi, afterEach } from "vitest";
import { createAppSubscription, getAppSubscription } from "../../src/integrations/shopify-billing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAppSubscription", () => {
  it("sends a GraphQL appSubscriptionCreate mutation and returns the confirmation URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://abc-fashion.myshopify.com/admin/api/2024-10/graphql.json");
        expect((init?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_token");
        const body = JSON.parse(init?.body as string);
        expect(body.query).toContain("appSubscriptionCreate");
        expect(body.variables.name).toBe("Medium");
        expect(body.variables.lineItems[0].plan.appRecurringPricingDetails.price.currencyCode).toBe("USD");
        return new Response(
          JSON.stringify({
            data: {
              appSubscriptionCreate: {
                appSubscription: { id: "gid://shopify/AppSubscription/1" },
                confirmationUrl: "https://abc-fashion.myshopify.com/admin/charges/1/confirm",
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        );
      }),
    );
    const result = await createAppSubscription("abc-fashion.myshopify.com", "shpat_token", "medium", "https://d2c.probild.in/api/shopify-app/billing-callback");
    expect(result).toEqual({ confirmationUrl: "https://abc-fashion.myshopify.com/admin/charges/1/confirm", subscriptionGid: "gid://shopify/AppSubscription/1" });
  });

  it("throws if Shopify returns userErrors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: null, confirmationUrl: null, userErrors: [{ field: ["name"], message: "Name can't be blank" }] } } }),
          { status: 200 },
        ),
      ),
    );
    await expect(createAppSubscription("abc-fashion.myshopify.com", "shpat_token", "small", "https://d2c.probild.in/x")).rejects.toThrow(/Name can't be blank/);
  });

  it("throws when the GraphQL request itself fails (non-2xx)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server error", { status: 500 })),
    );
    await expect(createAppSubscription("abc-fashion.myshopify.com", "shpat_token", "small", "https://d2c.probild.in/x")).rejects.toThrow(/GraphQL request failed/);
  });

  it("throws when Shopify returns top-level GraphQL errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ errors: [{ message: "Field 'appSubscriptionCreate' doesn't exist" }] }), { status: 200 }),
      ),
    );
    await expect(createAppSubscription("abc-fashion.myshopify.com", "shpat_token", "small", "https://d2c.probild.in/x")).rejects.toThrow(/doesn't exist/);
  });
});

describe("getAppSubscription", () => {
  it("queries the subscription's current status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { node: { status: "ACTIVE", name: "Medium" } } }), { status: 200 }),
      ),
    );
    const result = await getAppSubscription("abc-fashion.myshopify.com", "shpat_token", "gid://shopify/AppSubscription/1");
    expect(result).toEqual({ status: "ACTIVE", name: "Medium" });
  });

  it("throws when the node is missing (bad or stale gid)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { node: null } }), { status: 200 })),
    );
    await expect(getAppSubscription("abc-fashion.myshopify.com", "shpat_token", "gid://shopify/AppSubscription/999")).rejects.toThrow(/not found/i);
  });
});
