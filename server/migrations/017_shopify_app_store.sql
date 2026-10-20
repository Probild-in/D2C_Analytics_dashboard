-- server/migrations/017_shopify_app_store.sql
-- Supports the Shopify App Store app: a brand-new account-acquisition channel alongside
-- the existing agency-connect and Razorpay self-serve flows. See
-- docs/superpowers/specs/2026-10-20-shopify-app-store-design.md.

-- Lets the install callback recognize a reinstall of an already-provisioned shop,
-- instead of creating a duplicate account.
alter table clients add column shopify_shop_domain text unique;

-- Distinguishes which billing system backs a subscription, so the existing Razorpay
-- webhook handler and this plan's new Shopify billing webhook handler never process a
-- charge id that belongs to the other system.
alter table subscriptions add column billing_provider text not null default 'razorpay' check (billing_provider in ('razorpay', 'shopify'));
