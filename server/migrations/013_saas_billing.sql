-- Add-on prices (flat across tiers today per the pricing screenshots, but stored
-- per-plan so tiered add-on pricing is possible later without a schema change).
alter table plans add column extra_meta_account_price_inr integer;
alter table plans add column extra_google_account_price_inr integer;
alter table plans add column extra_shopify_store_price_inr integer;

update plans set
  extra_meta_account_price_inr = 499,
  extra_google_account_price_inr = 499,
  extra_shopify_store_price_inr = 999
where id in ('small', 'medium', 'large', 'enterprise');

-- This column has always stored Razorpay's *subscription* reference, not a
-- customer reference — the name was a misnomer from when this table was first
-- scaffolded. Renamed while this table is already being wired to a real gateway.
alter table subscriptions rename column gateway_customer_id to gateway_subscription_id;

-- Enterprise "Contact us" lead capture. No email-sending infrastructure exists
-- anywhere in this app yet, so storing leads is simpler and more reliable than
-- adding one.
create table enterprise_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text not null,
  estimated_orders_per_month integer,
  message text,
  created_at timestamptz not null default now()
);
