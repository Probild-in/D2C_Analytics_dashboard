import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

const WEBHOOK_SECRET = "test-webhook-secret";

function signWebhookBody(rawBody: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
}

function postWebhook(rawBody: string, signature?: string) {
  const req = request(app).post("/api/webhooks/razorpay").set("Content-Type", "application/json");
  if (signature !== undefined) req.set("X-Razorpay-Signature", signature);
  return req.send(rawBody);
}

beforeEach(async () => {
  await resetTestDb();
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into subscriptions (id, client_id, plan_id, status, gateway_subscription_id, current_period_start, current_period_end) values
     ('22222222-2222-2222-2222-222222222222', 'abc-fashion', 'medium', 'active', 'sub_abc123', now(), now() + interval '30 days')`,
  );
});

describe("POST /api/webhooks/razorpay", () => {
  it("subscription.charged updates the period and records a paid invoice", async () => {
    const rawBody = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_abc123", current_start: 1760000000, current_end: 1762592000 } },
        payment: { entity: { id: "pay_new123", amount: 299900 } },
      },
    });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);

    const sub = await testPool.query("select current_period_start, current_period_end from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(new Date(sub.rows[0].current_period_start).getTime()).toBe(1760000000 * 1000);

    const invoices = await testPool.query(
      "select amount_inr, status from invoices where subscription_id = '22222222-2222-2222-2222-222222222222' order by created_at desc limit 1",
    );
    expect(invoices.rows[0]).toMatchObject({ amount_inr: 2999, status: "paid" });
  });

  it("subscription.halted marks the subscription past_due", async () => {
    const rawBody = JSON.stringify({ event: "subscription.halted", payload: { subscription: { entity: { id: "sub_abc123" } } } });
    await postWebhook(rawBody, signWebhookBody(rawBody));
    const sub = await testPool.query("select status from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(sub.rows[0].status).toBe("past_due");
  });

  it("subscription.cancelled marks the subscription canceled", async () => {
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_abc123" } } } });
    await postWebhook(rawBody, signWebhookBody(rawBody));
    const sub = await testPool.query("select status from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(sub.rows[0].status).toBe("canceled");
  });

  it("redelivering the same subscription.charged event does not duplicate the invoice", async () => {
    const rawBody = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_abc123", current_start: 1760000000, current_end: 1762592000 } },
        payment: { entity: { id: "pay_new123", amount: 299900 } },
      },
    });
    await postWebhook(rawBody, signWebhookBody(rawBody));
    await postWebhook(rawBody, signWebhookBody(rawBody));
    const invoices = await testPool.query(
      "select count(*)::int as count from invoices where subscription_id = '22222222-2222-2222-2222-222222222222' and status = 'paid'",
    );
    // Exactly one invoice for this specific Razorpay payment id, not two — see Step 3's
    // razorpay_payment_id uniqueness note.
    expect(invoices.rows[0].count).toBe(1);
  });

  it("rejects an invalid signature", async () => {
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_abc123" } } } });
    const res = await postWebhook(rawBody, "0".repeat(64));
    expect(res.status).toBe(401);
    const sub = await testPool.query("select status from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(sub.rows[0].status).toBe("active");
  });

  it("200s on an unrecognized event type without erroring", async () => {
    const rawBody = JSON.stringify({ event: "some.future.event", payload: {} });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);
  });

  it("200s for an unknown gateway_subscription_id (stale/test webhook) rather than erroring", async () => {
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_unknown" } } } });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);
  });

  it("never touches a shopify-billed subscription with the same-looking gateway id (M1)", async () => {
    // A SEPARATE client (subscriptions.client_id is unique, so this can't reuse abc-fashion's
    // row from beforeEach) billed through the Shopify App Store, whose gateway_subscription_id
    // happens to collide with what a Razorpay webhook might send.
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('shopify-billed-co', 'Shopify Billed Co', 'Uncategorized', 'bg-blue-500', 'S')`,
    );
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ('shopify-billed-co', 'medium', 'active', 'sub_shopify_lookalike', 'shopify')`,
    );
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_shopify_lookalike" } } } });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);
    const sub = await testPool.query(
      "select status from subscriptions where gateway_subscription_id = 'sub_shopify_lookalike' and billing_provider = 'shopify'",
    );
    expect(sub.rows[0].status).toBe("active"); // unchanged — billing_provider gate held
  });
});
