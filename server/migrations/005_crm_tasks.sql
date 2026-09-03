create table crm_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  title text not null,
  description text not null default '',
  assignee_id uuid not null references team_members(id),
  priority text not null check (priority in ('Low', 'Medium', 'High', 'Urgent')),
  status text not null check (status in ('To Do', 'In Progress', 'Waiting', 'Completed')),
  due_date date not null,
  tags text[] not null default '{}',
  comments_count integer not null default 0,
  created_by uuid not null references team_members(id),
  created_at timestamptz not null default now()
);

create index crm_tasks_client_idx on crm_tasks (client_id);
