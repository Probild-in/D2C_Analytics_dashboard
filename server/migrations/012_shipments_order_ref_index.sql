-- Supports the shipments.order_ref = shopify_orders.shopify_order_id join used to
-- attribute RTO status per order/product/geography once a client has a courier connected
-- (see server/src/lib/rto-status.ts) — shopify_orders.status itself never actually contains
-- 'RTO Initiated'/'RTO Delivered' (Shopify has no native RTO concept: shopify.ts's
-- mapOrderStatus never produces it), so without this join every per-product and
-- per-geography RTO% silently read as 0 for any client with a real courier integration —
-- confirmed live against the Vayuraksh account (9 real RTO shipments, 0 shown anywhere
-- per-product).
create index shipments_client_order_ref_idx on shipments (client_id, order_ref);
