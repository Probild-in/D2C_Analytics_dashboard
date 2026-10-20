-- server/migrations/018_subscriptions_pending_status.sql
-- Fixes a gap in the Shopify App Store plan's own data model (migration 017): the
-- Shopify Billing API's appSubscriptionCreate returns control to this app BEFORE the
-- merchant has approved or declined the charge on Shopify's own confirmation screen, so
-- Task 6's /subscribe route needs to record the subscription immediately, in a state that
-- isn't yet 'active' — unlike the existing Razorpay flow (server/src/routes/signup.ts),
-- which only ever writes a subscription row AFTER Razorpay has already confirmed payment,
-- so it never needed a pre-confirmation status. The original check constraint
-- (001_init_schema.sql) has no such state. Widening it, not replacing it, keeps every
-- existing Razorpay-sourced row (which never used 'pending') unaffected.
alter table subscriptions drop constraint subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check
  check (status in ('pending', 'active', 'past_due', 'canceled', 'trialing'));
