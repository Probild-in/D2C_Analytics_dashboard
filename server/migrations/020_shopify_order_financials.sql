-- Per-order financial components, straight from Shopify's Order resource. Without
-- these the dashboard only had the final charged total (amount), which cannot
-- reproduce Shopify's own Gross/Net/Total sales breakdown — the numbers merchants
-- compare against. All nullable: rows synced before this migration backfill on the
-- next full re-sync (null last_synced_at to force one), and queries coalesce
-- (gross_amount -> amount, the rest -> 0) so legacy rows degrade to the old maths.
alter table shopify_orders
  add column gross_amount int,      -- total_line_items_price: pre-discount product revenue
  add column discount_amount int,   -- current_total_discounts
  add column tax_amount int,        -- current_total_tax
  add column shipping_amount int,   -- total_shipping_price_set.shop_money.amount
  add column refunded_amount int;   -- total_price - current_total_price (refund value)
