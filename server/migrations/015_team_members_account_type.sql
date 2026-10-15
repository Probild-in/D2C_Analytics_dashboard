-- Distinguishes agency staff (full roster visibility, can assign plans by hand, can
-- create extra brands) from self-serve customers (see/manage only their own client).
-- The spec assumed the existing access-scoping model already covered this; it didn't —
-- every pre-existing authenticated route trusted "logged in" to mean "agency staff",
-- which stopped being true the moment self-serve signups could log in too.
alter table team_members add column account_type text not null default 'staff' check (account_type in ('staff', 'self_serve_owner'));

-- Replay-safety: one Razorpay subscription must never back more than one local
-- subscription row (otherwise one verified payment could be reused to provision
-- multiple accounts). Postgres allows multiple NULLs under a unique constraint, so
-- rows with no gateway subscription (stub gateway, enterprise plans) are unaffected.
alter table subscriptions add constraint subscriptions_gateway_subscription_id_key unique (gateway_subscription_id);
