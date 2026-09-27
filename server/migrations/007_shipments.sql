create table shipments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  awb text not null,
  -- the courier's reference for the merchant order; kept for a future match to shopify_orders
  order_ref text,
  courier_name text not null,
  status text not null check (status in (
    'Dispatched', 'In Transit', 'Out for Delivery', 'Delivered', 'NDR', 'RTO Initiated', 'RTO Delivered', 'Cancelled'
  )),
  destination_state text,
  ordered_at timestamptz,
  delivered_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (connection_id, awb)
);

create index shipments_client_ordered_idx on shipments (client_id, ordered_at);
