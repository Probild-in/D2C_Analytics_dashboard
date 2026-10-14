import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";

const WEBHOOK_SECRET = "test-webhook-secret";

function signWebhookBody(rawBody: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");
}

function postWebhook(rawBody: string, opts: { hmac?: string; shopDomain?: string } = {}) {
  const req = request(app)
    .post("/api/webhooks/shopify/orders")
    .set("Content-Type", "application/json");
  if (opts.hmac !== undefined) req.set("X-Shopify-Hmac-Sha256", opts.hmac);
  if (opts.shopDomain !== undefined) req.set("X-Shopify-Shop-Domain", opts.shopDomain);
  return req.send(rawBody);
}

const SAMPLE_ORDER = {
  id: 7001,
  created_at: "2026-10-14T06:00:00Z",
  total_price: "1200.00",
  financial_status: "paid",
  fulfillment_status: "fulfilled",
  cancelled_at: null,
  customer: { id: 5001, first_name: "Riya", last_name: "Kapoor" },
  shipping_address: { city: "Mumbai", province: "Maharashtra" },
  payment_gateway_names: ["shopify_payments"],
  line_items: [{ id: 9001, title: "Tote Bag", quantity: 1, price: "1200.00" }],
};

beforeEach(async () => {
  await resetTestDb();
  process.env.SHOPIFY_API_SECRET = WEBHOOK_SECRET;
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

describe("POST /api/webhooks/shopify/orders", () => {
  it("upserts the order the instant a correctly signed webhook arrives", async () => {
    const rawBody = JSON.stringify(SAMPLE_ORDER);
    const res = await postWebhook(rawBody, { hmac: signWebhookBody(rawBody), shopDomain: "abc-fashion.myshopify.com" });

    expect(res.status).toBe(200);
    const order = await testPool.query("select * from shopify_orders where shopify_order_id = '7001'");
    expect(order.rowCount).toBe(1);
    expect(order.rows[0]).toMatchObject({ customer_name: "Riya Kapoor", amount: 1200, status: "Delivered" });

    const conn = await testPool.query("select last_synced_at from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
  });

  it("delivering the same order webhook twice updates it in place, not duplicated", async () => {
    const first = JSON.stringify(SAMPLE_ORDER);
    await postWebhook(first, { hmac: signWebhookBody(first), shopDomain: "abc-fashion.myshopify.com" });

    const updated = JSON.stringify({ ...SAMPLE_ORDER, total_price: "1500.00" });
    await postWebhook(updated, { hmac: signWebhookBody(updated), shopDomain: "abc-fashion.myshopify.com" });

    const orders = await testPool.query("select amount from shopify_orders where shopify_order_id = '7001'");
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0].amount).toBe(1500);
  });

  it("rejects a request with an invalid signature and does not write anything", async () => {
    const rawBody = JSON.stringify(SAMPLE_ORDER);
    const res = await postWebhook(rawBody, { hmac: "not-a-real-signature", shopDomain: "abc-fashion.myshopify.com" });

    expect(res.status).toBe(401);
    const order = await testPool.query("select * from shopify_orders where shopify_order_id = '7001'");
    expect(order.rowCount).toBe(0);
  });

  it("rejects a request with no signature header", async () => {
    const rawBody = JSON.stringify(SAMPLE_ORDER);
    const res = await postWebhook(rawBody, { shopDomain: "abc-fashion.myshopify.com" });
    expect(res.status).toBe(401);
  });

  it("404s a correctly signed webhook for a shop we don't have a connection for", async () => {
    const rawBody = JSON.stringify(SAMPLE_ORDER);
    const res = await postWebhook(rawBody, { hmac: signWebhookBody(rawBody), shopDomain: "unknown-shop.myshopify.com" });

    expect(res.status).toBe(404);
    const order = await testPool.query("select * from shopify_orders where shopify_order_id = '7001'");
    expect(order.rowCount).toBe(0);
  });

  it("404s for a shop whose connection was disconnected", async () => {
    await testPool.query("update platform_connections set status = 'disconnected' where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    const rawBody = JSON.stringify(SAMPLE_ORDER);
    const res = await postWebhook(rawBody, { hmac: signWebhookBody(rawBody), shopDomain: "abc-fashion.myshopify.com" });
    expect(res.status).toBe(404);
  });
});
