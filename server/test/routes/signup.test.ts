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

  function stubFetchForSuccessfulSupabaseCreate(userId = "11111111-1111-1111-1111-111111111111") {
    return vi.fn(async (url: string) => {
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

    const teamMembers = await testPool.query("select id, name, email, role, all_client_access from team_members where email = 'riya@newbrand.com'");
    expect(teamMembers.rows[0]).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Riya Kapoor",
      role: "owner",
      all_client_access: false,
    });

    const scoping = await testPool.query("select client_id from team_member_clients where team_member_id = '11111111-1111-1111-1111-111111111111'");
    expect(scoping.rows).toEqual([{ client_id: "new-brand-co" }]);

    const subs = await testPool.query("select plan_id, status, gateway_subscription_id from subscriptions where client_id = 'new-brand-co'");
    expect(subs.rows[0]).toMatchObject({ plan_id: "medium", status: "active", gateway_subscription_id: "sub_abc123" });

    const invoices = await testPool.query(
      "select amount_inr, status from invoices where subscription_id = (select id from subscriptions where client_id = 'new-brand-co')",
    );
    expect(invoices.rows[0]).toMatchObject({ amount_inr: 2999, status: "paid" });
  });

  it("rejects an invalid payment signature and creates nothing", async () => {
    const res = await request(app).post("/api/signup/complete").send({ ...validBody, razorpaySignature: "0".repeat(64) });
    expect(res.status).toBe(400);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });

  it("rejects a duplicate email before touching the database", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 })),
    );
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(409);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });

  it("resubmitting the same already-completed signup does not create a second client", async () => {
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate());
    await request(app).post("/api/signup/complete").send(signedBody());

    // Second attempt: Supabase now correctly reports the email as taken, since the first
    // request really did create it — this IS the idempotency guard, not a separate code path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 })),
    );
    const second = await request(app).post("/api/signup/complete").send(signedBody());
    expect(second.status).toBe(409);
    expect((await testPool.query("select count(*)::int as count from clients where name = 'New Brand Co'")).rows[0].count).toBe(1);
  });

  it("deletes the orphaned Supabase user if a later provisioning step fails", async () => {
    // Forces a DB failure after team_members succeeds by pre-inserting a team_members row
    // that will collide with the transaction's own insert. This happens on the second
    // provisioning statement (after team_members insert succeeds on the route's generated user id,
    // it will fail when the new signup tries to insert the same team_member id again on the
    // team_member_clients join - actually the conflict is on the team_members insert itself).
    // Pre-insert a team_members row to force a PK error on the main route's attempt to insert
    // the Supabase user, which proves the route correctly cleans up the orphaned Supabase user.
    const supabaseUserId = "11111111-1111-1111-1111-111111111111";
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ($1, 'Existing Member', 'existing@existing.com', 'owner', false)`,
      [supabaseUserId],
    );
    const deleteCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deleteCalls.push(url);
          return new Response(null, { status: 200 });
        }
        if (url.includes("/auth/v1/admin/users")) {
          return new Response(JSON.stringify({ id: supabaseUserId }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const res = await request(app)
      .post("/api/signup/complete")
      .send(signedBody());
    expect(res.status).toBe(500);
    expect(deleteCalls).toEqual([`https://test-project.supabase.co/auth/v1/admin/users/${supabaseUserId}`]);
    // Assert that the pre-inserted row is unchanged (no additional rows with this ID were created)
    expect((await testPool.query("select count(*) from team_members where id = $1", [supabaseUserId])).rows[0].count).toBe("1");
  });
});
