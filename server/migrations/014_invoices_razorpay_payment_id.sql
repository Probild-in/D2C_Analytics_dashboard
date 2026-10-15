-- Lets a redelivered subscription.charged webhook (standard Razorpay behavior, not an
-- edge case) be a no-op instead of recording a duplicate paid invoice.
alter table invoices add column razorpay_payment_id text unique;
