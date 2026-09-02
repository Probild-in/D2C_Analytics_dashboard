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

  it("allows multiple connections for same client_id and platform with different external_account_id", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')`,
    );
    // This should succeed - different external_account_id, same client_id and platform
    const result = await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'shopify', 'connected', 'shop-2.myshopify.com')
       returning id`,
    );
    expect(result.rowCount).toBe(1);
  });

  it("enforces one courier shipment per (connection_id, order_reference)", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    const connRes = await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'courier_delhivery', 'connected', 'acc-1')
       returning id`,
    );
    const connectionId = connRes.rows[0].id;
    await testPool.query(
      `insert into courier_shipments (client_id, connection_id, order_reference, status)
       values ('c1', $1, 'order-ref-1', 'in_transit')`,
      [connectionId],
    );
    await expect(
      testPool.query(
        `insert into courier_shipments (client_id, connection_id, order_reference, status)
         values ('c1', $1, 'order-ref-1', 'delivered')`,
        [connectionId],
      ),
    ).rejects.toThrow();
  });

  it("allows multiple courier shipments for same connection_id with different order_reference", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    const connRes = await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'courier_delhivery', 'connected', 'acc-1')
       returning id`,
    );
    const connectionId = connRes.rows[0].id;
    await testPool.query(
      `insert into courier_shipments (client_id, connection_id, order_reference, status)
       values ('c1', $1, 'order-ref-1', 'in_transit')`,
      [connectionId],
    );
    // This should succeed - different order_reference, same connection_id
    const result = await testPool.query(
      `insert into courier_shipments (client_id, connection_id, order_reference, status)
       values ('c1', $1, 'order-ref-2', 'delivered')
       returning id`,
      [connectionId],
    );
    expect(result.rowCount).toBe(1);
  });

  it("enforces one line item per (order_id, shopify_line_item_id)", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    const connRes = await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')
       returning id`,
    );
    const connectionId = connRes.rows[0].id;
    const orderRes = await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
       values ('c1', $1, 'order-123', 'John Doe', now(), 10000, 'completed', 'card')
       returning id`,
      [connectionId],
    );
    const orderId = orderRes.rows[0].id;
    await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price)
       values ($1, 'line-item-1', 'Widget', 2, 5000)`,
      [orderId],
    );
    await expect(
      testPool.query(
        `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price)
         values ($1, 'line-item-1', 'Another Widget', 1, 5000)`,
        [orderId],
      ),
    ).rejects.toThrow();
  });

  it("allows multiple line items for same order_id with different shopify_line_item_id", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    const connRes = await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')
       returning id`,
    );
    const connectionId = connRes.rows[0].id;
    const orderRes = await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
       values ('c1', $1, 'order-123', 'John Doe', now(), 10000, 'completed', 'card')
       returning id`,
      [connectionId],
    );
    const orderId = orderRes.rows[0].id;
    await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price)
       values ($1, 'line-item-1', 'Widget', 2, 5000)`,
      [orderId],
    );
    // This should succeed - different shopify_line_item_id, same order_id
    const result = await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price)
       values ($1, 'line-item-2', 'Gadget', 1, 3000)
       returning id`,
      [orderId],
    );
    expect(result.rowCount).toBe(1);
  });

  it("shopify_orders has a nullable shopify_customer_id column", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('test-client', 'Test', 'Fashion', 'bg-violet-500', 'T')`,
    );
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('33333333-3333-3333-3333-333333333333', 'Owner', 'owner@agency.com', 'owner', true)`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('44444444-4444-4444-4444-444444444444', 'test-client', 'shopify', 'connected', 'test.myshopify.com')`,
    );
    const result = await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id)
       values ('test-client', '44444444-4444-4444-4444-444444444444', '1001', 'Guest Checkout', now(), 500, 'Delivered', 'Prepaid', null)
       returning shopify_customer_id`,
    );
    expect(result.rows[0].shopify_customer_id).toBeNull();
  });
});
