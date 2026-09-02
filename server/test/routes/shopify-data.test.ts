import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

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
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
});

describe("GET /api/clients/:id/sales", () => {
  it("returns one point per day, including zero-order days, with new vs returning customers", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now() - interval '1 day', 1000, 'Delivered', 'Prepaid', '9001'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Priya Shah', now(), 500, 'Delivered', 'COD', '9001'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '3', 'Amit Rao', now(), 800, 'Cancelled', 'Prepaid', '9002')`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=3")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    const today = res.body[res.body.length - 1];
    expect(today.orders).toBe(2);
    expect(today.netSales).toBe(500);
    expect(today.cancelledOrders).toBe(1);
    expect(today.newCustomers).toBe(1);
    expect(today.returningCustomers).toBe(1);
    expect(today.adSpend).toBe(0);

    const yesterday = res.body[res.body.length - 2];
    expect(yesterday.orders).toBe(1);
    expect(yesterday.newCustomers).toBe(1);

    const threeDaysAgo = res.body[0];
    expect(threeDaysAgo.orders).toBe(0);
    expect(threeDaysAgo.netSales).toBe(0);
  });

  it("renders the date field as the correct calendar date regardless of server timezone", async () => {
    // order_date is a fixed, unambiguous UTC timestamp: 2026-08-15T10:00:00Z is
    // 2026-08-15 15:30 in Asia/Kolkata (+5:30), so the calendar date is
    // 2026-08-15 under any timezone offset up to +13/-12. A buggy
    // `r.day.toISOString().slice(0, 10)` mapping (which reinterprets a
    // locally-constructed Date as UTC) would roll this back to 2026-08-14
    // on any host running ahead of UTC.
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '4', 'Neha Singh', '2026-08-15T10:00:00Z', 1200, 'Delivered', 'Prepaid', '9003')`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    // A wide window guarantees 2026-08-15 falls within [current_date - 89, current_date]
    // without the assertion itself depending on now()/current_date.
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=90")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const seededDay = res.body.find((r: { date: string }) => r.date === "2026-08-15");
    expect(seededDay).toBeDefined();
    expect(seededDay.orders).toBe(1);
    expect(seededDay.netSales).toBe(1200);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=7")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
