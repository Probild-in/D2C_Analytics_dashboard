import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
});

describe("migration 013 (SaaS billing schema)", () => {
  it("seeds add-on prices on every existing plan", async () => {
    const res = await testPool.query(
      "select id, extra_meta_account_price_inr, extra_google_account_price_inr, extra_shopify_store_price_inr from plans order by id",
    );
    expect(res.rows).toEqual([
      { id: "enterprise", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
      { id: "large", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
      { id: "medium", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
      { id: "small", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
    ]);
  });

  it("renamed gateway_customer_id to gateway_subscription_id on subscriptions", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values
       ('abc-fashion', 'small', 'active', 'sub_test123')`,
    );
    const res = await testPool.query("select gateway_subscription_id from subscriptions where client_id = 'abc-fashion'");
    expect(res.rows[0].gateway_subscription_id).toBe("sub_test123");
  });

  it("stores an enterprise lead", async () => {
    await testPool.query(
      `insert into enterprise_leads (name, email, company, estimated_orders_per_month, message) values
       ('Riya Kapoor', 'riya@bigbrand.com', 'Big Brand Co', 8000, 'Need a custom plan')`,
    );
    const res = await testPool.query("select name, email, company, estimated_orders_per_month, message from enterprise_leads");
    expect(res.rows).toEqual([
      { name: "Riya Kapoor", email: "riya@bigbrand.com", company: "Big Brand Co", estimated_orders_per_month: 8000, message: "Need a custom plan" },
    ]);
  });

  it("allows a null estimated_orders_per_month and message", async () => {
    await testPool.query(`insert into enterprise_leads (name, email, company) values ('Amit Rao', 'amit@brand.com', 'Brand Co')`);
    const res = await testPool.query("select estimated_orders_per_month, message from enterprise_leads");
    expect(res.rows[0]).toEqual({ estimated_orders_per_month: null, message: null });
  });
});
