import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

const expectedTables = [
  "team_members",
  "team_member_clients",
  "clients",
  "plans",
  "subscriptions",
  "invoices",
  "platform_connections",
  "sync_logs",
  "shopify_orders",
  "shopify_order_line_items",
  "meta_campaign_metrics",
  "google_campaign_metrics",
  "courier_shipments",
];

describe("schema", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it.each(expectedTables)("creates table %s", async (table) => {
    const res = await testPool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = $1",
      [table],
    );
    expect(res.rowCount).toBe(1);
  });

  it("enforces one connection per (client_id, platform, external_account_id)", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')`,
    );
    await expect(
      testPool.query(
        `insert into platform_connections (client_id, platform, status, external_account_id)
         values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')`,
      ),
    ).rejects.toThrow();
  });
});
