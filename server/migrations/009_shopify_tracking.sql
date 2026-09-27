-- Confirmed via Shopify's Admin REST API `order` resource: each fulfillment carries
-- tracking_company / tracking_number. We capture the first fulfillment's values only
-- (a multi-fulfillment order only records one courier's tracking number — accepted gap).
alter table shopify_orders add column tracking_number text;
alter table shopify_orders add column tracking_company text;
