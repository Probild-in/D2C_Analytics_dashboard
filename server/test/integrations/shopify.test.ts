import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shopifyConnector } from "../../src/integrations/shopify.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

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
    const query = { shop: "test-shop.myshopify.com", code: "auth-code-123" };
    const hmac = computeTestHmac(query, "test-api-secret");
    const result = await shopifyConnector.handleCallback({ ...query, hmac }, { clientId: "abc-fashion" });
    expect(result).toEqual({ externalAccountId: "test-shop.myshopify.com", accessToken: "shpat_real_token" });
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid request", { status: 400 })));
    const query = { shop: "test-shop.myshopify.com", code: "bad-code" };
    const hmac = computeTestHmac(query, "test-api-secret");
    await expect(shopifyConnector.handleCallback({ ...query, hmac }, { clientId: "abc-fashion" })).rejects.toThrow();
  });

  it("throws if the shop query param is missing", async () => {
    await expect(shopifyConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow();
  });

  it("throws if shop is not a valid *.myshopify.com domain", async () => {
    const query = { shop: "attacker-controlled-server.example", code: "auth-code-123" };
    const hmac = computeTestHmac(query, "test-api-secret");
    await expect(shopifyConnector.handleCallback({ ...query, hmac }, { clientId: "abc-fashion" })).rejects.toThrow(/myshopify\.com/);
  });

  it("throws if the hmac is missing", async () => {
    const query = { shop: "test-shop.myshopify.com", code: "auth-code-123" };
    await expect(shopifyConnector.handleCallback(query, { clientId: "abc-fashion" })).rejects.toThrow(/HMAC/);
  });

  it("throws if the hmac doesn't match", async () => {
    const query = { shop: "test-shop.myshopify.com", code: "auth-code-123", hmac: "0".repeat(64) };
    await expect(shopifyConnector.handleCallback(query, { clientId: "abc-fashion" })).rejects.toThrow(/HMAC/);
  });

  it("throws if the hmac was computed with the wrong secret", async () => {
    const query = { shop: "test-shop.myshopify.com", code: "auth-code-123" };
    const hmac = computeTestHmac(query, "wrong-secret");
    await expect(shopifyConnector.handleCallback({ ...query, hmac }, { clientId: "abc-fashion" })).rejects.toThrow(/HMAC/);
  });
});

describe("shopifyConnector.sync", () => {
  beforeEach(async () => {
    await resetTestDb();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
  });

  it("upserts orders and line items from the Shopify Orders API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("https://abc-fashion.myshopify.com/admin/api/");
        expect(url).toContain("/orders.json");
        return new Response(
          JSON.stringify({
            orders: [
              {
                id: 1001,
                created_at: "2026-08-15T10:00:00Z",
                total_price: "1499.00",
                financial_status: "paid",
                fulfillment_status: "fulfilled",
                cancelled_at: null,
                customer: { id: 9001, first_name: "Priya", last_name: "Shah" },
                shipping_address: { city: "Mumbai", province: "Maharashtra" },
                payment_gateway_names: ["shopify_payments"],
                line_items: [{ id: 501, title: "Cotton Kurta", quantity: 2, price: "749.50" }],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(1);

    const orders = await testPool.query("select * from shopify_orders where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0]).toMatchObject({
      shopify_order_id: "1001",
      customer_name: "Priya Shah",
      amount: 1499,
      status: "Delivered",
      payment_method: "Prepaid",
      city: "Mumbai",
      state: "Maharashtra",
      shopify_customer_id: "9001",
    });

    const lineItems = await testPool.query("select * from shopify_order_line_items where order_id = $1", [orders.rows[0].id]);
    expect(lineItems.rowCount).toBe(1);
    expect(lineItems.rows[0]).toMatchObject({ product_name: "Cotton Kurta", quantity: 2, price: 750 });
  });

  it("marks an unfulfilled, non-cancelled order as Dispatched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            orders: [
              {
                id: 1002,
                created_at: "2026-08-16T10:00:00Z",
                total_price: "500.00",
                financial_status: "pending",
                fulfillment_status: null,
                cancelled_at: null,
                customer: null,
                shipping_address: null,
                payment_gateway_names: ["cash_on_delivery"],
                line_items: [],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    const orders = await testPool.query("select * from shopify_orders where shopify_order_id = '1002'");
    expect(orders.rows[0]).toMatchObject({ status: "Dispatched", payment_method: "COD", customer_name: "Guest", shopify_customer_id: null });
  });

  it("marks a cancelled order as Cancelled regardless of fulfillment status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            orders: [
              {
                id: 1003,
                created_at: "2026-08-17T10:00:00Z",
                total_price: "300.00",
                financial_status: "voided",
                fulfillment_status: null,
                cancelled_at: "2026-08-17T12:00:00Z",
                customer: null,
                shipping_address: null,
                payment_gateway_names: [],
                line_items: [],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    const orders = await testPool.query("select status from shopify_orders where shopify_order_id = '1003'");
    expect(orders.rows[0].status).toBe("Cancelled");
  });

  it("re-syncing the same order updates it in place, not duplicated", async () => {
    const makeResponse = (financial: string) =>
      new Response(
        JSON.stringify({
          orders: [
            {
              id: 1004,
              created_at: "2026-08-18T10:00:00Z",
              total_price: "800.00",
              financial_status: financial,
              fulfillment_status: "fulfilled",
              cancelled_at: null,
              customer: null,
              shipping_address: null,
              payment_gateway_names: ["shopify_payments"],
              line_items: [],
            },
          ],
        }),
        { status: 200 },
      );
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse("pending")));
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse("paid")));
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");

    const orders = await testPool.query("select * from shopify_orders where shopify_order_id = '1004'");
    expect(orders.rowCount).toBe(1);
  });

  it("paginates through multiple pages using the Link header", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              orders: [
                {
                  id: 2001,
                  created_at: "2026-08-19T10:00:00Z",
                  total_price: "100.00",
                  financial_status: "paid",
                  fulfillment_status: "fulfilled",
                  cancelled_at: null,
                  customer: null,
                  shipping_address: null,
                  payment_gateway_names: ["shopify_payments"],
                  line_items: [],
                },
              ],
            }),
            {
              status: 200,
              headers: {
                Link: '<https://abc-fashion.myshopify.com/admin/api/2024-10/orders.json?page_info=abc123&limit=250>; rel="next"',
              },
            },
          );
        }
        expect(url).toBe("https://abc-fashion.myshopify.com/admin/api/2024-10/orders.json?page_info=abc123&limit=250");
        return new Response(
          JSON.stringify({
            orders: [
              {
                id: 2002,
                created_at: "2026-08-20T10:00:00Z",
                total_price: "200.00",
                financial_status: "paid",
                fulfillment_status: "fulfilled",
                cancelled_at: null,
                customer: null,
                shipping_address: null,
                payment_gateway_names: ["shopify_payments"],
                line_items: [],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(2);

    const orders = await testPool.query(
      "select shopify_order_id from shopify_orders where connection_id = $1 order by shopify_order_id",
      ["55555555-5555-5555-5555-555555555555"],
    );
    expect(orders.rows.map((r) => r.shopify_order_id)).toEqual(["2001", "2002"]);
  });

  it("updates last_synced_at and resets status to connected on the connection", async () => {
    await testPool.query("update platform_connections set status = 'error' where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    const conn = await testPool.query("select last_synced_at, status from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
    expect(conn.rows[0].status).toBe("connected");
  });
});

describe("shopifyConnector.disconnect", () => {
  beforeEach(async () => {
    await resetTestDb();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
  });

  it("marks the connection disconnected", async () => {
    await shopifyConnector.disconnect("55555555-5555-5555-5555-555555555555");
    const conn = await testPool.query("select status from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].status).toBe("disconnected");
  });
});
