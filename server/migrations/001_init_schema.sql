create table team_members (
  id uuid primary key,
  name text not null,
  email text not null unique,
  role text not null check (role in ('owner', 'manager', 'marketer', 'team_member')),
  all_client_access boolean not null default false,
  created_at timestamptz not null default now()
);

create table clients (
  id text primary key,
  name text not null,
  category text not null,
  logo_color text not null,
  logo_initial text not null,
  owner_id uuid references team_members(id),
  created_at timestamptz not null default now()
);

create table team_member_clients (
  team_member_id uuid not null references team_members(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  primary key (team_member_id, client_id)
);

create table plans (
  id text primary key,
  name text not null,
  order_limit integer,
  monthly_fee_inr integer not null,
  included_meta_accounts integer not null,
  included_google_accounts integer not null
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique references clients(id) on delete cascade,
  plan_id text not null references plans(id),
  status text not null check (status in ('active', 'past_due', 'canceled', 'trialing')),
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default now() + interval '30 days',
  extra_shopify_stores integer not null default 0,
  extra_meta_accounts integer not null default 0,
  extra_google_accounts integer not null default 0,
  gateway_customer_id text,
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  amount_inr integer not null,
  status text not null check (status in ('pending', 'paid', 'failed')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  gateway_payment_id text,
  created_at timestamptz not null default now()
);

create table platform_connections (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  platform text not null check (platform in ('shopify', 'meta', 'google', 'courier_delhivery', 'courier_shadowfax')),
  status text not null check (status in ('connected', 'disconnected', 'error')),
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  external_account_id text not null,
  metadata jsonb not null default '{}',
  last_synced_at timestamptz,
  connected_by uuid references team_members(id),
  created_at timestamptz not null default now(),
  unique (client_id, platform, external_account_id)
);

create table sync_logs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references platform_connections(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_synced integer,
  error text
);

create table shopify_orders (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  shopify_order_id text not null,
  customer_name text not null,
  order_date timestamptz not null,
  amount integer not null,
  status text not null,
  payment_method text not null,
  city text,
  state text,
  courier text,
  synced_at timestamptz not null default now(),
  unique (connection_id, shopify_order_id)
);

create table shopify_order_line_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references shopify_orders(id) on delete cascade,
  shopify_line_item_id text not null,
  product_name text not null,
  quantity integer not null,
  price integer not null,
  unique (order_id, shopify_line_item_id)
);

create table meta_campaign_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  campaign_id text not null,
  campaign_name text not null,
  metric_date date not null,
  spend integer not null,
  impressions integer not null,
  clicks integer not null,
  results integer not null,
  synced_at timestamptz not null default now(),
  unique (connection_id, campaign_id, metric_date)
);

create table google_campaign_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  campaign_id text not null,
  campaign_name text not null,
  metric_date date not null,
  spend integer not null,
  impressions integer not null,
  clicks integer not null,
  conversions integer not null,
  synced_at timestamptz not null default now(),
  unique (connection_id, campaign_id, metric_date)
);

create table courier_shipments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  order_reference text not null,
  status text not null,
  synced_at timestamptz not null default now(),
  unique (connection_id, order_reference)
);
