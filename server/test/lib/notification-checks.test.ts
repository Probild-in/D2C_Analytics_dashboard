import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { getIstDayBoundaries, runDailyNotificationChecks } from "../../src/lib/notification-checks.js";

describe("getIstDayBoundaries", () => {
  it("returns a 24-hour range, with daysAgo=1 ending at daysAgo=0's start", () => {
    const yesterday = getIstDayBoundaries(1);
    const today = getIstDayBoundaries(0);
    expect(yesterday.end.getTime()).toBe(today.start.getTime());
    expect(today.start.getTime() - yesterday.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("runDailyNotificationChecks", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('33333333-3333-3333-3333-333333333333', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
    );
  });

  it("alerts RTO when yesterday's RTO rate is in the critical band (>=15%)", async () => {
    const { start } = getIstDayBoundaries(1);
    // 10 orders yesterday, 2 RTO'd (via shopify's own status, since no courier connected)
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000), i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind, title from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
  });

  it("does not alert RTO when yesterday's rate is healthy (<8%)", async () => {
    const { start } = getIstDayBoundaries(1);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000)],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(0);
  });

  it("does not crash and does not alert for a client with zero orders yesterday (RTO, sales, ads, roas all skip cleanly)", async () => {
    await expect(runDailyNotificationChecks(testPool)).resolves.not.toThrow();
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion'");
    expect(notifs.rowCount).toBe(0);
  });

  it("alerts a sales dip of >=20% vs the same weekday one week before yesterday", async () => {
    const yesterday = getIstDayBoundaries(1);
    const weekBefore = getIstDayBoundaries(8);
    // 10 orders the comparison day, 5 yesterday => 50% dip
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `last-week-${i}`, new Date(weekBefore.start.getTime() + i * 60000)],
      );
    }
    for (let i = 0; i < 5; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `yesterday-${i}`, new Date(yesterday.start.getTime() + i * 60000)],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind from notifications where client_id = 'abc-fashion' and kind = 'sales'");
    expect(notifs.rowCount).toBe(1);
  });

  it("does not alert a sales dip when last week's comparison day had zero orders", async () => {
    const yesterday = getIstDayBoundaries(1);
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
      ["abc-fashion", "33333333-3333-3333-3333-333333333333", "yesterday-1", new Date(yesterday.start.getTime())],
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'sales'");
    expect(notifs.rowCount).toBe(0);
  });

  it("does not insert a second notification of the same kind within the de-dup window", async () => {
    const { start } = getIstDayBoundaries(1);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000), i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
  });

  it("re-alerts on a later day if the condition still holds, once the de-dup window has passed", async () => {
    const { start } = getIstDayBoundaries(1);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000), i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    // Simulate the first alert having happened outside the 20-hour de-dup window (e.g.
    // yesterday's run), so a client stuck in `critical` for multiple days running gets a
    // fresh notification each day, not just once ever.
    await testPool.query(
      "update notifications set created_at = now() - interval '25 hours' where client_id = 'abc-fashion' and kind = 'rto'",
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(2);
  });
});
