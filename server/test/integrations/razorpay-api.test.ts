import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSubscription,
  verifySubscriptionPaymentSignature,
  verifyWebhookSignature,
  getRazorpayKeyId,
} from "../../src/integrations/razorpay-api.js";

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.RAZORPAY_PLAN_ID_SMALL = "plan_small123";
  process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
  process.env.RAZORPAY_PLAN_ID_LARGE = "plan_large123";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSubscription", () => {
  it("creates a Razorpay subscription against the plan's mapped Razorpay Plan ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
        expect(init?.headers).toMatchObject({ Authorization: expect.stringContaining("Basic ") });
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({ plan_id: "plan_medium123", customer_notify: 1 });
        expect(body.total_count).toBeGreaterThan(0);
        return new Response(JSON.stringify({ id: "sub_abc123", status: "created" }), { status: 200 });
      }),
    );
    const result = await createSubscription("medium");
    expect(result).toEqual({ id: "sub_abc123" });
  });

  it("throws if Razorpay rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { description: "bad plan" } }), { status: 400 })));
    await expect(createSubscription("small")).rejects.toThrow(/Razorpay subscription creation failed/);
  });
});

describe("verifySubscriptionPaymentSignature", () => {
  it("accepts a correctly computed signature", () => {
    const paymentId = "pay_xyz789";
    const subscriptionId = "sub_abc123";
    const signature = crypto.createHmac("sha256", "test-key-secret").update(`${paymentId}|${subscriptionId}`).digest("hex");
    expect(
      verifySubscriptionPaymentSignature({ razorpayPaymentId: paymentId, razorpaySubscriptionId: subscriptionId, razorpaySignature: signature }),
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    expect(
      verifySubscriptionPaymentSignature({ razorpayPaymentId: "pay_xyz789", razorpaySubscriptionId: "sub_abc123", razorpaySignature: "0".repeat(64) }),
    ).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed raw body", () => {
    const body = Buffer.from(JSON.stringify({ event: "subscription.charged" }));
    const signature = crypto.createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(Buffer.from("{}"), undefined)).toBe(false);
  });
});

describe("getRazorpayKeyId", () => {
  it("returns the configured key id", () => {
    expect(getRazorpayKeyId()).toBe("rzp_test_key123");
  });
});
