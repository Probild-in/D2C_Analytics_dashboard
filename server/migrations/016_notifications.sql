-- server/migrations/016_notifications.sql
-- Real notifications, replacing the dashboard's previously-fake, hardcoded bell menu
-- (src/data/mock.ts's getNotifications()). See
-- docs/superpowers/specs/2026-10-16-real-notifications-design.md for the full design.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  kind text not null check (kind in ('rto', 'sales', 'ads', 'roas', 'task')),
  title text not null,
  description text not null,
  created_at timestamptz not null default now()
);

create index notifications_client_id_created_at_idx on notifications (client_id, created_at desc);

-- Per-staff-member read state — a notification is unread for a given team member
-- until they have a row here. Different team members reading the same client's
-- notifications must not share read state.
create table notification_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  team_member_id uuid not null references team_members(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, team_member_id)
);
