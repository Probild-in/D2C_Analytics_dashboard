import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { resetTestDb } from "../helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  process.env.RAZORPAY_PLAN_ID_SMALL = "plan_small123";
  process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
  process.env.RAZORPAY_PLAN_ID_LARGE = "plan_large123";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/signup", () => {
  it("creates a Razorpay subscription and returns its id plus the publishable key, with no auth required", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sub_abc123" }), { status: 200 })));
    const res = await request(app).post("/api/signup").send({ planId: "medium" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ razorpaySubscriptionId: "sub_abc123", razorpayKeyId: "rzp_test_key123" });
  });

  it("rejects planId 'enterprise'", async () => {
    const res = await request(app).post("/api/signup").send({ planId: "enterprise" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("no_self_serve_enterprise");
  });

  it("rejects an unknown planId", async () => {
    const res = await request(app).post("/api/signup").send({ planId: "nonexistent" });
    expect(res.status).toBe(400);
  });

  it("400s a missing planId", async () => {
    const res = await request(app).post("/api/signup").send({});
    expect(res.status).toBe(400);
  });
});
