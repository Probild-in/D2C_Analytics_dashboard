import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import request from "supertest";
import app from "../../src/index.js";
import { resetTestDb, testPool } from "../helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  process.env.RAZORPAY_PLAN_ID_SMALL = "plan_small123";
  process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
  process.env.RAZORPAY_PLAN_ID_LARGE = "plan_large123";
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
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

  it("409s an already-registered email before creating any Razorpay subscription", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('33333333-3333-3333-3333-333333333333', 'Existing Owner', 'existing@brand.com', 'owner', false)`,
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called — no Razorpay subscription should be created for a taken email");
    });
    vi.stubGlobal("fetch", fetchMock);
    // Different case + surrounding whitespace: the check is case-insensitive.
    const res = await request(app).post("/api/signup").send({ planId: "medium", email: "  Existing@Brand.com " });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_already_registered");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/signup/complete", () => {
  const validBody = {
    razorpaySubscriptionId: "sub_abc123",
    razorpayPaymentId: "pay_xyz789",
    planId: "medium",
    brandName: "New Brand Co",
    category: "Fashion & Apparel",
    ownerName: "Riya Kapoor",
    email: "riya@newbrand.com",
    password: "a-real-password",
  };

  function signedBody(overrides: Partial<typeof validBody> = {}) {
    const body = { ...validBody, ...overrides };
    const razorpaySignature = crypto
      .createHmac("sha256", "test-key-secret")
      .update(`${body.razorpayPaymentId}|${body.razorpaySubscriptionId}`)
      .digest("hex");
    return { ...body, razorpaySignature };
  }

  // Razorpay's real billing period for the stubbed subscription (unix seconds).
  const CURRENT_START = 1760486400; // 2025-10-15T00:00:00Z
  const CURRENT_END = 1763164800; // 2025-11-15T00:00:00Z

  // GET https://api.razorpay.com/v1/subscriptions/{id} — the server-side verification
  // /complete now does before trusting anything about the payment.
  function razorpaySubscriptionResponse(url: string, overrides: Record<string, unknown> = {}) {
    const subscriptionId = url.split("/v1/subscriptions/")[1];
    return new Response(
      JSON.stringify({
        id: subscriptionId,
        plan_id: "plan_medium123",
        status: "active",
        current_start: CURRENT_START,
        current_end: CURRENT_END,
        ...overrides,
      }),
      { status: 200 },
    );
  }

  function stubFetchForSuccessfulSupabaseCreate(
    userId = "11111111-1111-1111-1111-111111111111",
    razorpayOverrides: Record<string, unknown> = {},
  ) {
    return vi.fn(async (url: string) => {
      if (url.includes("api.razorpay.com/v1/subscriptions/")) {
        return razorpaySubscriptionResponse(url, razorpayOverrides);
      }
      if (url.includes("/auth/v1/admin/users")) {
        return new Response(JSON.stringify({ id: userId }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("provisions a client, team member, and subscription, and returns 200 on a valid payment", async () => {
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate());
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(200);

    const clients = await testPool.query("select id, name, category, owner_id from clients where name = 'New Brand Co'");
    expect(clients.rowCount).toBe(1);
    expect(clients.rows[0]).toMatchObject({ id: "new-brand-co", category: "Fashion & Apparel", owner_id: "11111111-1111-1111-1111-111111111111" });

    const teamMembers = await testPool.query(
      "select id, name, email, role, all_client_access, account_type from team_members where email = 'riya@newbrand.com'",
    );
    expect(teamMembers.rows[0]).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Riya Kapoor",
      role: "owner",
      all_client_access: false,
      account_type: "self_serve_owner",
    });

    const scoping = await testPool.query("select client_id from team_member_clients where team_member_id = '11111111-1111-1111-1111-111111111111'");
    expect(scoping.rows).toEqual([{ client_id: "new-brand-co" }]);

    const subs = await testPool.query(
      "select plan_id, status, gateway_subscription_id, current_period_start, current_period_end from subscriptions where client_id = 'new-brand-co'",
    );
    expect(subs.rows[0]).toMatchObject({ plan_id: "medium", status: "active", gateway_subscription_id: "sub_abc123" });
    // The billing period comes from Razorpay's own response, not "now + 30 days".
    expect(subs.rows[0].current_period_start.getTime()).toBe(CURRENT_START * 1000);
    expect(subs.rows[0].current_period_end.getTime()).toBe(CURRENT_END * 1000);

    const invoices = await testPool.query(
      "select amount_inr, status, razorpay_payment_id, period_start, period_end from invoices where subscription_id = (select id from subscriptions where client_id = 'new-brand-co')",
    );
    expect(invoices.rows[0]).toMatchObject({ amount_inr: 2999, status: "paid", razorpay_payment_id: "pay_xyz789" });
    expect(invoices.rows[0].period_start.getTime()).toBe(CURRENT_START * 1000);
    expect(invoices.rows[0].period_end.getTime()).toBe(CURRENT_END * 1000);
  });

  it("rejects an invalid payment signature and creates nothing", async () => {
    const res = await request(app).post("/api/signup/complete").send({ ...validBody, razorpaySignature: "0".repeat(64) });
    expect(res.status).toBe(400);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });

  it("rejects a duplicate email before touching the database", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.razorpay.com/v1/subscriptions/")) {
          return razorpaySubscriptionResponse(url);
        }
        return new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 });
      }),
    );
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(409);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });

  it("resubmitting the same already-completed signup does not create a second client", async () => {
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate());
    await request(app).post("/api/signup/complete").send(signedBody());

    // Second attempt: the subscription id is already backing a local subscription, so the
    // replay guard rejects it before Razorpay or Supabase is even contacted (Supabase
    // would also report the email as taken — that remains the backstop).
    const secondFetch = vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 }));
    vi.stubGlobal("fetch", secondFetch);
    const second = await request(app).post("/api/signup/complete").send(signedBody());
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("payment_already_processed");
    expect(secondFetch).not.toHaveBeenCalled();
    expect((await testPool.query("select count(*)::int as count from clients where name = 'New Brand Co'")).rows[0].count).toBe(1);
  });

  it("rolls back already-written rows and deletes the orphaned Supabase user if a later provisioning step fails", async () => {
    // Force a failure at the `subscriptions` insert — the fourth statement in the
    // transaction — by removing the plan row it needs (subscriptions.plan_id has a
    // foreign-key constraint to plans(id)). By this point team_members, clients, and
    // team_member_clients have already been written inside the same transaction, so this
    // proves the ROLLBACK genuinely undoes real prior writes, not just a first-statement
    // failure. Deleting this row is isolated to this test: resetTestDb's beforeEach drops
    // and recreates the whole schema (reseeding plans) before every test.
    await testPool.query("delete from plans where id = 'medium'");

    const supabaseUserId = "11111111-1111-1111-1111-111111111111";
    const deleteCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deleteCalls.push(url);
          return new Response(null, { status: 200 });
        }
        if (url.includes("api.razorpay.com/v1/subscriptions/")) {
          return razorpaySubscriptionResponse(url);
        }
        if (url.includes("/auth/v1/admin/users")) {
          return new Response(JSON.stringify({ id: supabaseUserId }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const res = await request(app).post("/api/signup/complete").send(signedBody());

    expect(res.status).toBe(500);
    expect(deleteCalls).toEqual([`https://test-project.supabase.co/auth/v1/admin/users/${supabaseUserId}`]);
    // All three rows that DID succeed before the subscriptions insert failed must be gone —
    // this is the actual proof that ROLLBACK undid real, already-written data.
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
    expect((await testPool.query("select * from team_members where email = 'riya@newbrand.com'")).rowCount).toBe(0);
    expect((await testPool.query("select * from team_member_clients where team_member_id = $1", [supabaseUserId])).rowCount).toBe(0);
  });

  // NOTE: /complete's IP rate limiter (max 10/hour) is module-level and is NOT reset
  // between tests in this file. This describe block makes exactly 10 /complete requests
  // in total; adding another one here will start returning 429s.

  it("rejects a replayed payment (same signed subscription/payment ids, different account details) with 409", async () => {
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate());
    const first = await request(app).post("/api/signup/complete").send(signedBody());
    expect(first.status).toBe(200);

    // Same razorpaySubscriptionId/razorpayPaymentId/razorpaySignature (still a "valid"
    // signature — it only binds payment id to subscription id), different account.
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate("22222222-2222-2222-2222-222222222222"));
    const replay = await request(app)
      .post("/api/signup/complete")
      .send(signedBody({ email: "attacker@other.com", brandName: "Freeloader Brand" }));
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("payment_already_processed");

    const subs = await testPool.query("select id, client_id from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(subs.rowCount).toBe(1);
    expect(subs.rows[0].client_id).toBe("new-brand-co");
    expect((await testPool.query("select count(*)::int as count from clients")).rows[0].count).toBe(1);
    expect((await testPool.query("select count(*)::int as count from invoices where subscription_id = $1", [subs.rows[0].id])).rows[0].count).toBe(1);
    expect((await testPool.query("select * from team_members where email = 'attacker@other.com'")).rowCount).toBe(0);
  });

  it("uses the plan Razorpay says the subscription is for, ignoring the request body's planId", async () => {
    // The subscription was really created for "small" (plan_small123); the body claims "large".
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate(undefined, { plan_id: "plan_small123" }));
    const res = await request(app).post("/api/signup/complete").send(signedBody({ planId: "large" }));
    expect(res.status).toBe(200);

    const subs = await testPool.query("select id, plan_id from subscriptions where client_id = 'new-brand-co'");
    expect(subs.rows[0].plan_id).toBe("small");
    const invoices = await testPool.query("select amount_inr from invoices where subscription_id = $1", [subs.rows[0].id]);
    expect(invoices.rows[0].amount_inr).toBe(1499);
  });

  it("rejects a subscription Razorpay hasn't confirmed payment for yet, and persists nothing", async () => {
    const fetchMock = stubFetchForSuccessfulSupabaseCreate(undefined, { status: "created" });
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("payment_not_confirmed");

    // No Supabase user was created either — only the Razorpay verification GET ran.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://api.razorpay.com/v1/subscriptions/sub_abc123"]);
    expect((await testPool.query("select * from clients")).rowCount).toBe(0);
    expect((await testPool.query("select * from team_members")).rowCount).toBe(0);
    expect((await testPool.query("select * from subscriptions")).rowCount).toBe(0);
    expect((await testPool.query("select * from invoices")).rowCount).toBe(0);
  });
});
