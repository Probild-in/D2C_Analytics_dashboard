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
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'meta', 'connected', 'act_123')`,
  );
});

describe("migration 011 (campaign revenue)", () => {
  it("defaults revenue to 0 on meta_campaign_metrics when not provided", async () => {
    await testPool.query(
      `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp-1', 'Camp', current_date, 100, 1000, 20, 2)`,
    );
    const res = await testPool.query("select revenue from meta_campaign_metrics where campaign_id = 'camp-1'");
    expect(res.rows[0].revenue).toBe(0);
  });

  it("stores a real revenue value on meta_campaign_metrics, google_campaign_metrics, and campaign_creatives", async () => {
    await testPool.query(
      `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results, revenue) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp-1', 'Camp', current_date, 100, 1000, 20, 2, 450)`,
    );
    await testPool.query(
      `insert into google_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, conversions, revenue) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp-2', 'Camp G', current_date, 100, 1000, 20, 2, 550)`,
    );
    const campaignRow = await testPool.query(
      `insert into campaigns (client_id, connection_id, external_campaign_id, name, status) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp-1', 'Camp', 'active') returning id`,
    );
    await testPool.query(
      `insert into campaign_creatives (campaign_id, external_creative_id, name, format, status, spend, impressions, clicks, results, revenue) values
       ($1, 'creative-1', 'Creative', 'CAROUSEL', 'active', 50, 500, 10, 1, 225)`,
      [campaignRow.rows[0].id],
    );

    expect((await testPool.query("select revenue from meta_campaign_metrics where campaign_id = 'camp-1'")).rows[0].revenue).toBe(450);
    expect((await testPool.query("select revenue from google_campaign_metrics where campaign_id = 'camp-2'")).rows[0].revenue).toBe(550);
    expect((await testPool.query("select revenue from campaign_creatives where external_creative_id = 'creative-1'")).rows[0].revenue).toBe(225);
  });
});
