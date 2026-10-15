import { describe, it, expect, vi, afterEach } from "vitest";
import { razorpayGateway } from "../../src/integrations/payment-gateway.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("razorpayGateway.createSubscription", () => {
  it("creates a real Razorpay subscription and returns its id as the gateway customer id", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
    process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
    process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sub_abc123" }), { status: 200 })));

    const result = await razorpayGateway.createSubscription("abc-fashion", "medium");
    expect(result).toEqual({ gatewayCustomerId: "sub_abc123" });
  });
});
