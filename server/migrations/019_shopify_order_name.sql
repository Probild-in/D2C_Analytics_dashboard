-- server/migrations/019_shopify_order_name.sql
-- The dashboard's order lists/detail view were showing shopify_orders.id (this table's
-- own internal uuid primary key) as "the order number" — meaningless to a merchant, and
-- visibly different from the real Shopify order number (e.g. "VR15537") they see in
-- Shopify Admin. Shopify's Orders API already returns this in the same response
-- upsertShopifyOrder already fetches (the `name` field) — it was just never captured.
-- Nullable: existing synced orders backfill this the next time they're touched by a
-- sync (status change, webhook update); a one-off historical backfill is out of scope
-- for this fix.
alter table shopify_orders add column order_name text;
