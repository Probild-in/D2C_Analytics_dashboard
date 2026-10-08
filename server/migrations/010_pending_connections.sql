-- Holds an in-flight OAuth result that needs a user choice before it becomes a real
-- platform_connections row: Meta's ad-account picker (plan 4) and Shopify's install-link
-- client claim (plan 5). client_id/team_member_id are both known up front for Meta's
-- picker; both are null until claimed for Shopify's install link.
create table pending_connections (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  client_id text references clients(id) on delete cascade,
  team_member_id uuid references team_members(id),
  -- Encrypted JSON (same encryptToken scheme as platform_connections' own token columns).
  -- Never returned by any GET endpoint — only its decrypted, non-secret fields are.
  payload text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
