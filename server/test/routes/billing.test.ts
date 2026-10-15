import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/clients/:id/subscription", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
  });

  it("returns plans list even with no subscription yet", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toBeNull();
  });

  it("flags overOrderLimit when order count exceeds the plan limit", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'small', 'active')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('99999999-9999-9999-9999-999999999999', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
    );
    const orderInserts = Array.from({ length: 301 }, (_, i) =>
      testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
         values ('abc-fashion', '99999999-9999-9999-9999-999999999999', $1, 'Test Customer', now(), 1000, 'Delivered', 'Prepaid')`,
        [`order-${i}`],
      ),
    );
    await Promise.all(orderInserts);

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe("small");
    expect(res.body.overOrderLimit).toBe(true);
  });

  it("excludes orders dated after the current period end from the count", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, current_period_start, current_period_end)
       values ('abc-fashion', 'small', 'active', now() - interval '1 day', now())`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('99999999-9999-9999-9999-999999999999', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
    );
    // All orders are dated after current_period_end, so none should count toward the limit.
    const orderInserts = Array.from({ length: 301 }, (_, i) =>
      testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
         values ('abc-fashion', '99999999-9999-9999-9999-999999999999', $1, 'Test Customer', now() + interval '1 day', 1000, 'Delivered', 'Prepaid')`,
        [`order-${i}`],
      ),
    );
    await Promise.all(orderInserts);

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe("small");
    expect(res.body.overOrderLimit).toBe(false);
  });
});

describe("POST /api/clients/:id/subscription", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    // Set up Razorpay credentials for the real gateway
    process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
    process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
    process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
    // Stub fetch to return a subscription ID
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sub_abc123" }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a subscription and a pending invoice via the real Razorpay gateway", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "medium" });

    expect(res.status).toBe(201);
    expect(res.body.subscription.status).toBe("active");

    const invoices = await testPool.query("select * from invoices");
    expect(invoices.rowCount).toBe(1);
    expect(invoices.rows[0].status).toBe("pending");
    expect(invoices.rows[0].amount_inr).toBe(2999);

    // Verify the subscription has a real Razorpay subscription ID
    const subscriptions = await testPool.query("select gateway_subscription_id from subscriptions where client_id = $1", ["abc-fashion"]);
    expect(subscriptions.rowCount).toBe(1);
    expect(subscriptions.rows[0].gateway_subscription_id).toBe("sub_abc123");
  });

  it("returns 404 for a nonexistent client id", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/does-not-exist/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "medium" });
    expect(res.status).toBe(404);
  });

  it("rejects an unknown plan id", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "does-not-exist" });
    expect(res.status).toBe(400);
  });

  it("does not create duplicate invoices when re-posting with same plan", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });

    // First POST to create subscription
    const res1 = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "medium" });
    expect(res1.status).toBe(201);

    // Re-stub fetch for the second call — a no-op repost of the current plan must NOT
    // create a new Razorpay subscription shell.
    const secondFetch = vi.fn(async () => new Response(JSON.stringify({ id: "sub_def456" }), { status: 200 }));
    vi.stubGlobal("fetch", secondFetch);

    // Second POST with same planId (retry or duplicate)
    const res2 = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "medium" });
    expect(res2.status).toBe(201);
    expect(secondFetch).not.toHaveBeenCalled();

    // Verify only 1 invoice exists, not 2
    const invoices = await testPool.query("select count(*) from invoices");
    expect(invoices.rows[0].count).toBe("1");

    // The original Razorpay subscription id is kept, not overwritten or nulled.
    const subs = await testPool.query("select gateway_subscription_id from subscriptions where client_id = 'abc-fashion'");
    expect(subs.rows[0].gateway_subscription_id).toBe("sub_abc123");
  });

  it("persists the new Razorpay subscription id on a real plan change", async () => {
    process.env.RAZORPAY_PLAN_ID_LARGE = "plan_large123";
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    await request(app).post("/api/clients/abc-fashion/subscription").set("Authorization", `Bearer ${token}`).send({ planId: "medium" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sub_def456" }), { status: 200 })));
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "large" });
    expect(res.status).toBe(201);

    const subs = await testPool.query("select plan_id, gateway_subscription_id from subscriptions where client_id = 'abc-fashion'");
    expect(subs.rows[0]).toEqual({ plan_id: "large", gateway_subscription_id: "sub_def456" });
  });

  it("assigns 'enterprise' without calling Razorpay at all", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called — enterprise has no Razorpay Plan");
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "enterprise" });

    expect(res.status).toBe(201);
    expect(res.body.subscription).toEqual({ status: "active", planId: "enterprise" });
    expect(fetchMock).not.toHaveBeenCalled();

    const subs = await testPool.query("select plan_id, gateway_subscription_id from subscriptions where client_id = 'abc-fashion'");
    expect(subs.rows[0]).toEqual({ plan_id: "enterprise", gateway_subscription_id: null });
  });

  it("403s a self-serve owner even for their own client", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access, account_type) values
       ('33333333-3333-3333-3333-333333333333', 'Self Serve', 'owner@selfserve.com', 'owner', false, 'self_serve_owner')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values ('33333333-3333-3333-3333-333333333333', 'abc-fashion')`,
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called for a rejected caller");
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = signTestJwt({ sub: "33333333-3333-3333-3333-333333333333", email: "owner@selfserve.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "large" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("staff_only");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await testPool.query("select * from subscriptions")).rowCount).toBe(0);
  });
});
