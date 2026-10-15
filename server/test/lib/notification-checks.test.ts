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

  // Spreads `count` order_date values evenly across the RTO check's new trailing-7-day
  // window (getIstDayBoundaries(7).start through getIstDayBoundaries(1).end), rather than
  // all within a single day, so these fixtures actually exercise the new window shape
  // instead of just happening to also fall inside it.
  function spreadAcrossRtoWindow(count: number): Date[] {
    const windowStart = getIstDayBoundaries(7).start;
    const windowEnd = getIstDayBoundaries(1).end;
    const windowMs = windowEnd.getTime() - windowStart.getTime();
    return Array.from({ length: count }, (_, i) => new Date(windowStart.getTime() + Math.floor((i * windowMs) / count)));
  }

  it("alerts RTO when the trailing-7-day RTO rate is in the critical band (>=15%)", async () => {
    const dates = spreadAcrossRtoWindow(10);
    // 10 orders across the 7-day window, 2 RTO'd (via shopify's own status, since no courier connected)
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, dates[i], i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind, title, description from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
    expect(notifs.rows[0].description).toMatch(/over the last 7 days/);
  });

  it("does not alert RTO when the trailing-7-day rate is healthy (<8%)", async () => {
    const dates = spreadAcrossRtoWindow(10);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, dates[i]],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(0);
  });

  it("alerts RTO at the attention band (8%-15%) for a trailing-7-day rate, not just the critical band", async () => {
    const dates = spreadAcrossRtoWindow(10);
    // 10 orders across the 7-day window, 1 RTO'd => 10%, inside the 8-15% attention band.
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, dates[i], i < 1 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select description from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
    expect(notifs.rows[0].description).toMatch(/attention threshold/);
  });

  it("alerts RTO for an order placed 5 days ago that a connected courier marked RTO — the real-world case a single-day window could never catch", async () => {
    // Reuses the courier_shiprocket platform_connections + shipments fixture pattern from
    // server/test/routes/courier-data.test.ts. shipments are looked up by order_ref only
    // (no date requirement of their own), per ORDER_RTO_CTES_SINGLE_CLIENT in rto-status.ts.
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('66666666-6666-6666-6666-666666666666', 'abc-fashion', 'courier_shiprocket', 'connected', 'abc-fashion@ops.com')`,
    );
    const { start: fiveDaysAgo } = getIstDayBoundaries(5);
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ($1, $2, $3, 'Test', $4, 1000, 'Dispatched', 'COD')`,
      ["abc-fashion", "33333333-3333-3333-3333-333333333333", "order-rto-5d-ago", fiveDaysAgo],
    );
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, order_ref, courier_name, status) values
       ($1, $2, $3, $4, 'Shiprocket', 'RTO Initiated')`,
      ["abc-fashion", "66666666-6666-6666-6666-666666666666", "AWB-RTO-5D", "order-rto-5d-ago"],
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
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

  // Mirrors notification-checks.ts's own istDateString helper, independently, so these
  // fixture inserts land on the correct IST calendar date regardless of the test
  // process's ambient TZ (the same class of bug this whole fix round is about).
  function istDateStringForDaysAgo(daysAgo: number): string {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const { start } = getIstDayBoundaries(daysAgo);
    const ist = new Date(start.getTime() + IST_OFFSET_MS);
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
  }

  it("alerts an ad spend anomaly when yesterday's spend is >=25% above the trailing 7-day average", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('44444444-4444-4444-4444-444444444444', 'abc-fashion', 'meta', 'connected', 'abc-fashion-meta')`,
    );
    // Trailing 7 complete days before yesterday (daysAgo=2..8): spend 100/day => average 100.
    for (let daysAgo = 2; daysAgo <= 8; daysAgo++) {
      await testPool.query(
        `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
         ($1, $2, $3, 'Test Campaign', $4::date, $5, 0, 0, 0)`,
        ["abc-fashion", "44444444-4444-4444-4444-444444444444", `trailing-${daysAgo}`, istDateStringForDaysAgo(daysAgo), 100],
      );
    }
    // Yesterday's spend: 130 => 30% above the 100 trailing average, clears the 25% threshold.
    await testPool.query(
      `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
       ($1, $2, 'yesterday-campaign', 'Test Campaign', $3::date, $4, 0, 0, 0)`,
      ["abc-fashion", "44444444-4444-4444-4444-444444444444", istDateStringForDaysAgo(1), 130],
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind from notifications where client_id = 'abc-fashion' and kind = 'ads'");
    expect(notifs.rowCount).toBe(1);
  });

  it("alerts blended ROAS below target when yesterday's net sales / ad spend < 3.0", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'google', 'connected', 'abc-fashion-google')`,
    );
    const yesterday = getIstDayBoundaries(1);
    // Ad spend of 1000 and net sales of 2000 => ROAS 2.0x, below the 3.0x target.
    await testPool.query(
      `insert into google_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, conversions) values
       ($1, $2, 'yesterday-campaign', 'Test Campaign', $3::date, $4, 0, 0, 0)`,
      ["abc-fashion", "55555555-5555-5555-5555-555555555555", istDateStringForDaysAgo(1), 1000],
    );
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ($1, $2, 'roas-order-1', 'Test', $3, 2000, 'Delivered', 'COD')`,
      ["abc-fashion", "33333333-3333-3333-3333-333333333333", new Date(yesterday.start.getTime())],
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind from notifications where client_id = 'abc-fashion' and kind = 'roas'");
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
