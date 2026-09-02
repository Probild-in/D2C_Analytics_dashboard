create table campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  external_campaign_id text not null,
  name text not null,
  status text not null check (status in ('active', 'paused', 'in review', 'completed')),
  created_at timestamptz not null default now(),
  unique (connection_id, external_campaign_id)
);

create table campaign_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  external_creative_id text not null,
  name text not null,
  format text not null,
  headline text,
  primary_text text,
  cta text,
  thumbnail_url text,
  status text not null,
  spend integer not null,
  impressions integer not null,
  clicks integer not null,
  results integer not null,
  hook_rate numeric,
  hold_rate numeric,
  launched_date date,
  synced_at timestamptz not null default now(),
  unique (campaign_id, external_creative_id)
);

create table campaign_notes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  author_id uuid not null references team_members(id),
  body text not null,
  created_at timestamptz not null default now()
);

create index campaigns_client_idx on campaigns (client_id);
create index campaign_creatives_campaign_idx on campaign_creatives (campaign_id);
create index campaign_notes_campaign_idx on campaign_notes (campaign_id);
