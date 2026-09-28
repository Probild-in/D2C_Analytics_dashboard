import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
});

describe("migration 009 (shopify tracking columns)", () => {
  it("stores a tracking number and company on a shopify order", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, tracking_number, tracking_company)
       values ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', 'AWB123', 'Delhivery Surface')`,
    );
    const res = await testPool.query("select tracking_number, tracking_company from shopify_orders");
    expect(res.rows).toEqual([{ tracking_number: "AWB123", tracking_company: "Delhivery Surface" }]);
  });

  it("both columns default to null", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
       values ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Dispatched', 'COD')`,
    );
    const res = await testPool.query("select tracking_number, tracking_company from shopify_orders where shopify_order_id = '2'");
    expect(res.rows).toEqual([{ tracking_number: null, tracking_company: null }]);
  });
});
