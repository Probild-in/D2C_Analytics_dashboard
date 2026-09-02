create index if not exists shopify_orders_client_date_idx on shopify_orders (client_id, order_date);
create index if not exists shopify_orders_client_customer_idx on shopify_orders (client_id, shopify_customer_id);
