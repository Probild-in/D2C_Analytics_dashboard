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
    // order_date is set to 30 days ago at noon UTC, making the calendar day
    // unambiguous across any timezone offset up to +13/-12. The JS-computed
    // expected date uses the same relative offset and UTC field access to
    // ensure consistency regardless of when the test runs.
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '4', 'Neha Singh', date_trunc('day', now() - interval '30 days') + interval '12 hours', 1200, 'Delivered', 'Prepaid', '9003')`,
    );

    // Compute expected date: 30 days ago, extracted in UTC
    const daysAgo = 30;
    const seedTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const year = seedTime.getUTCFullYear();
    const month = String(seedTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(seedTime.getUTCDate()).padStart(2, '0');
    const expectedDate = `${year}-${month}-${day}`;

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    // A wide window guarantees 30 days ago falls within [current_date - 89, current_date]
    // without the assertion itself depending on a hardcoded date.
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=90")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const seededDay = res.body.find((r: { date: string }) => r.date === expectedDate);
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

  it("counts a new customer once even if they place multiple orders on their first day", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '101', 'New Customer', now(), 400, 'Delivered', 'Prepaid', '9099'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '102', 'New Customer', now(), 600, 'Delivered', 'Prepaid', '9099')`,
    );
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].newCustomers).toBe(1);
  });

  it("counts RTO orders per day", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '201', 'Priya Shah', now(), 1000, 'RTO Initiated', 'COD'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '202', 'Amit Rao', now(), 500, 'RTO Delivered', 'COD'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '203', 'Neha Singh', now(), 700, 'Delivered', 'Prepaid')`,
    );
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].rtoOrders).toBe(2);
  });

  it("sums real Meta and Google ad spend for the correct day, scoped to this client", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('66666666-0000-0000-0000-000000000001', 'abc-fashion', 'meta', 'connected', 'act_123'),
       ('66666666-0000-0000-0000-000000000002', 'abc-fashion', 'google', 'connected', 'customers/456')`,
    );
    await testPool.query(
      `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
       ('abc-fashion', '66666666-0000-0000-0000-000000000001', 'camp-1', 'Meta Campaign', current_date, 3000, 10000, 200, 15)`,
    );
    await testPool.query(
      `insert into google_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, conversions) values
       ('abc-fashion', '66666666-0000-0000-0000-000000000002', 'g-camp-1', 'Google Campaign', current_date, 2000, 8000, 150, 10)`,
    );
    // A different client's spend must never leak into this client's total.
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('66666666-0000-0000-0000-000000000003', 'xyz-cosmetics', 'meta', 'connected', 'act_999')`,
    );
    await testPool.query(
      `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
       ('xyz-cosmetics', '66666666-0000-0000-0000-000000000003', 'camp-9', 'Other Client Campaign', current_date, 9999, 1, 1, 1)`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].adSpend).toBe(5000);
  });

  it("clientId=all aggregates sales across every client the caller can access", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('77777777-7777-7777-7777-777777777771', 'xyz-cosmetics', 'shopify', 'connected', 'xyz-cosmetics.myshopify.com')`,
    );
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid', '9001'),
       ('xyz-cosmetics', '77777777-7777-7777-7777-777777777771', '1', 'Ravi Kumar', now(), 500, 'Delivered', 'Prepaid', '9001')`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/all/sales?days=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].orders).toBe(2);
    expect(res.body[0].netSales).toBe(1500);
    // Same numeric shopify_customer_id ('9001') at two different stores must
    // count as two distinct new customers, not be deduped across clients.
    expect(res.body[0].newCustomers).toBe(2);
  });

  it("clientId=all scopes to only the clients a limited team member can access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values
       ('22222222-2222-2222-2222-222222222222', 'abc-fashion')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('77777777-7777-7777-7777-777777777772', 'xyz-cosmetics', 'shopify', 'connected', 'xyz-cosmetics.myshopify.com')`,
    );
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid'),
       ('xyz-cosmetics', '77777777-7777-7777-7777-777777777772', '1', 'Ravi Kumar', now(), 500, 'Delivered', 'Prepaid')`,
    );

    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/all/sales?days=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].orders).toBe(1);
    expect(res.body[0].netSales).toBe(1000);
  });
});

describe("GET /api/clients/:id/orders", () => {
  it("returns orders newest first, with a representative product name", async () => {
    await testPool.query(
      `insert into shopify_orders
         (id, client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state) values
       ('88888888-8888-8888-8888-888888888888', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now() - interval '1 day', 1000, 'Delivered', 'Prepaid', 'Mumbai', 'Maharashtra'),
       ('99999999-9999-9999-9999-999999999999', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Dispatched', 'COD', 'Pune', 'Maharashtra')`,
    );
    await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price) values
       ('99999999-9999-9999-9999-999999999999', 'li-1', 'Cotton Kurta', 1, 500)`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/orders?limit=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      clientId: "abc-fashion",
      customer: "Amit Rao",
      amount: 500,
      status: "Dispatched",
      payment: "COD",
      city: "Pune",
      state: "Maharashtra",
      product: "Cotton Kurta",
    });
    expect(res.body[1].customer).toBe("Priya Shah");
  });

  it("returns the real courier field when present", async () => {
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, courier) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', 'Delhivery')`,
    );
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/orders")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].courier).toBe("Delhivery");
  });

  it("returns an empty array for a client with no synced orders", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/orders")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/clients/:id/products", () => {
  it("aggregates line items into per-product totals", async () => {
    await testPool.query(
      `insert into shopify_orders (id, client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1500, 'Delivered', 'Prepaid'),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Cancelled', 'COD')`,
    );
    await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price) values
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'li-1', 'Cotton Kurta', 2, 750),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'li-2', 'Cotton Kurta', 1, 500)`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/products")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: "Cotton Kurta",
      orders: 3,
      sales: 2000,
      netSales: 1500,
      cancellationPercent: expect.closeTo(33.33, 1),
    });
  });
});

describe("GET /api/clients/:id/geography", () => {
  it("groups orders by state", async () => {
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid', 'Mumbai', 'Maharashtra'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Cancelled', 'COD', 'Pune', 'Maharashtra'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '3', 'Ravi Kumar', now(), 700, 'Delivered', 'Prepaid', 'Bengaluru', 'Karnataka')`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/geography?level=state")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const maharashtra = res.body.find((r: { name: string }) => r.name === "Maharashtra");
    expect(maharashtra).toMatchObject({ orders: 2, sales: 1500, cancellationPercent: 50 });
    const karnataka = res.body.find((r: { name: string }) => r.name === "Karnataka");
    expect(karnataka).toMatchObject({ orders: 1, sales: 700 });
  });

  it("groups orders by city when level=city", async () => {
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid', 'Mumbai', 'Maharashtra')`,
    );
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/geography?level=city")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("Mumbai");
  });
});
