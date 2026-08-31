import { describe, it, expect, beforeEach } from "vitest";
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
  });

  it("creates a subscription and a pending invoice via the stub gateway", async () => {
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

    // Second POST with same planId (retry or duplicate)
    const res2 = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "medium" });
    expect(res2.status).toBe(201);

    // Verify only 1 invoice exists, not 2
    const invoices = await testPool.query("select count(*) from invoices");
    expect(invoices.rows[0].count).toBe("1");
  });
});
