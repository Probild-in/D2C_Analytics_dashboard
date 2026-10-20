import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

describe("migration 017: shopify app store", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
  });

  it("allows setting shopify_shop_domain and enforces uniqueness", async () => {
    await testPool.query("update clients set shopify_shop_domain = 'abc-fashion.myshopify.com' where id = 'abc-fashion'");
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('xyz-beauty', 'XYZ Beauty', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await expect(
      testPool.query("update clients set shopify_shop_domain = 'abc-fashion.myshopify.com' where id = 'xyz-beauty'"),
    ).rejects.toThrow();
  });

  it("existing clients have no shopify_shop_domain by default", async () => {
    const res = await testPool.query("select shopify_shop_domain from clients where id = 'abc-fashion'");
    expect(res.rows[0].shopify_shop_domain).toBeNull();
  });

  it("subscriptions default to billing_provider = 'razorpay' and accept 'shopify'", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'small', 'active')`,
    );
    const defaultRow = await testPool.query("select billing_provider from subscriptions where client_id = 'abc-fashion'");
    expect(defaultRow.rows[0].billing_provider).toBe("razorpay");

    await testPool.query("update subscriptions set billing_provider = 'shopify' where client_id = 'abc-fashion'");
    const updated = await testPool.query("select billing_provider from subscriptions where client_id = 'abc-fashion'");
    expect(updated.rows[0].billing_provider).toBe("shopify");
  });

  it("rejects an unrecognized billing_provider", async () => {
    await expect(
      testPool.query(
        `insert into subscriptions (client_id, plan_id, status, billing_provider) values ('abc-fashion', 'small', 'active', 'stripe')`,
      ),
    ).rejects.toThrow();
  });
});
