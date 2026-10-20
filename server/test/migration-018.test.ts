import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

describe("migration 018: subscriptions pending status", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
  });

  it("allows a subscription row with status = 'pending'", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, billing_provider) values ('abc-fashion', 'small', 'pending', 'shopify')`,
    );
    const res = await testPool.query("select status from subscriptions where client_id = 'abc-fashion'");
    expect(res.rows[0].status).toBe("pending");
  });

  it("still allows every pre-existing status value", async () => {
    for (const status of ["active", "past_due", "canceled", "trialing"]) {
      await testPool.query("delete from subscriptions where client_id = 'abc-fashion'");
      await testPool.query(`insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'small', $1)`, [status]);
      const res = await testPool.query("select status from subscriptions where client_id = 'abc-fashion'");
      expect(res.rows[0].status).toBe(status);
    }
  });

  it("still rejects an unrecognized status", async () => {
    await expect(
      testPool.query(`insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'small', 'bogus')`),
    ).rejects.toThrow();
  });
});
