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
});
