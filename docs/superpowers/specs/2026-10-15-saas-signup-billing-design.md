# Self-Serve SaaS Signup & Billing — Design Spec

## Goal

Turn the D2C Analytics Dashboard from an internally-provisioned, agency-managed
tool into a self-serve product: a public pricing page, a plan-selection and
signup flow, real recurring billing via Razorpay, and automatic account
provisioning that logs the new customer straight into their own scoped
dashboard — no Probild staff involved in account creation.

## Context

- The `plans` table already seeds the exact four tiers from the pricing
  screenshots (Small/Medium/Large/Enterprise, matching order limits, monthly
  fees, and included Meta/Google account counts). `subscriptions` and
  `invoices` tables already exist. A `PaymentGateway` interface
  (`server/src/integrations/payment-gateway.ts`) is already stubbed with the
  right shape (`createSubscription`/`chargeInvoice`/`cancelSubscription`) —
  this spec replaces the stub with a real Razorpay implementation.
- Access scoping already supports exactly what a self-serve owner needs: a
  `team_members` row with `all_client_access = false` plus one
  `team_member_clients` row sees only its own client. A self-serve signup is
  simply "create these rows through a public endpoint instead of an admin
  internal flow" — no new access model required.
- There is currently no public account-creation path anywhere in this app;
  every `team_members`/`clients` row so far has been created manually.

## Known external constraint (not solved by this spec)

Meta Ads, Google Ads, and Shopify's public-install path all currently gate
OAuth connects to accounts Probild has manually allow-listed (Meta/Google
Testers, Shopify's custom-distribution org lock) — confirmed repeatedly
against the real platforms this session. A brand-new external self-serve
customer will hit the same rejection screens already seen throughout this
project's integration work, until each platform's own App Review is
separately completed (real external processes with their own timelines, not
something this spec can finish). This spec provisions the **account and
dashboard access**; the per-platform connect flows remain exactly as fragile
as they are today until those reviews clear. Out of scope here, flagged so
it isn't a surprise later.

## Architecture

One app, new public routes. No new deployable, no new auth system — the
existing React app gains public pages and the existing Express backend gains
public endpoints, reusing the current Supabase Auth and access-scoping model
unchanged.

**Pay-then-provision**: nothing is created in the database until Razorpay's
payment signature is verified. `POST /api/signup` only creates a Razorpay
Subscription shell (unpaid, pending the customer's checkout authorization).
Account provisioning — the Supabase user, the `clients`/`team_members`/
`team_member_clients`/`subscriptions`/`invoices` rows — happens in
`POST /api/signup/complete`, only after the payment signature checks out.
This means an abandoned checkout never leaves behind a free account to clean
up later.

## Data model changes

```sql
-- Add-on prices (flat across tiers today per the pricing screenshots, but
-- stored per-plan so tiered add-on pricing is possible later without a
-- schema change).
alter table plans add column extra_meta_account_price_inr integer;
alter table plans add column extra_google_account_price_inr integer;
alter table plans add column extra_shopify_store_price_inr integer;

update plans set
  extra_meta_account_price_inr = 499,
  extra_google_account_price_inr = 499,
  extra_shopify_store_price_inr = 999
where id in ('small', 'medium', 'large', 'enterprise');

-- Rename: this column has always stored Razorpay's *subscription* reference,
-- not a customer reference — the name was a misnomer from when this table
-- was first scaffolded. Renamed while this table is already being wired up
-- to a real gateway.
alter table subscriptions rename column gateway_customer_id to gateway_subscription_id;

-- Enterprise "Contact us" lead capture. No email-sending infrastructure
-- exists anywhere in this app yet, so storing leads is simpler and more
-- reliable than adding one — queried directly, same as everything else
-- Probild has been checking via SSH/psql all session.
create table enterprise_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text not null,
  estimated_orders_per_month integer,
  message text,
  created_at timestamptz not null default now()
);
```

## API endpoints

### `GET /api/plans` (public)
Returns all rows from `plans` (including the new add-on price columns), so
the pricing page is always sourced from the same data the backend actually
bills against — never hardcoded twice.

### `POST /api/signup` (public)
Request: `{ planId: "small" | "medium" | "large" }` (`"enterprise"` is
rejected here with a 400 pointing at `/contact-enterprise` — no self-serve
checkout for it, per the Contact Us decision).

Creates a Razorpay Subscription (`razorpay.subscriptions.create`) against the
Razorpay Plan ID mapped from `planId` (see Razorpay setup below) — status
`created`, nothing charged yet. Returns
`{ razorpaySubscriptionId, razorpayKeyId }` so the frontend can open Razorpay
Checkout. The brand/owner/email/password the user already typed into the
signup form stay in frontend state only — never sent or persisted at this
step.

### `POST /api/signup/complete` (public)
Request:
```
{
  razorpaySubscriptionId, razorpayPaymentId, razorpaySignature,
  planId, brandName, category, ownerName, email, password
}
```

1. Verify the signature: `hmac_sha256(key_secret, "${razorpayPaymentId}|${razorpaySubscriptionId}") === razorpaySignature` (Razorpay's documented formula for subscription payments). Invalid → 400, nothing created.
2. Create the Supabase Auth user via the Admin API (`email_confirm: true` — they just paid, no separate email-verification step needed).
3. In one DB transaction: generate a unique client id from `brandName` (same slugify-and-dedupe logic `clients.ts`'s `generateUniqueClientId` already uses — extract it to a shared `lib/slug.ts` so both call sites use the identical function), insert the `clients` row, the `team_members` row (id = the new Supabase user's id, role `owner`, `all_client_access = false`), the `team_member_clients` row, the `subscriptions` row (`status: 'active'`, `gateway_subscription_id`), and a `paid` `invoices` row.
4. If any step after Supabase user creation fails, delete the just-created Supabase user before returning the error (compensating action) — otherwise a retry would hit "email already registered" for an account that has no actual app data behind it.
5. Return 200. The frontend then calls `supabase.auth.signInWithPassword` itself with the same email/password, exactly like the existing login page does — no custom session-token plumbing needed server-side.

### `POST /api/enterprise-leads` (public)
Request: `{ name, email, company, estimatedOrdersPerMonth?, message? }`.
Inserts into `enterprise_leads`. Returns 201. No notification system is
built here (none exists yet) — Probild checks the table directly, same
pattern as everything else this session.

### `POST /api/webhooks/razorpay` (public)
Mounted ahead of `express.json()` with its own `express.raw()`, same
structure as the existing Shopify webhook route — unlike the courier
webhooks, Razorpay *does* sign its webhooks for real
(`X-Razorpay-Signature`, HMAC-SHA256 against a configured webhook secret),
so this one gets genuine signature verification, not a connection-id-only
safeguard.

Handles:
- `subscription.charged` → updates the matching `subscriptions` row's
  `current_period_start`/`current_period_end` from the event payload, inserts
  a new paid `invoices` row.
- `subscription.halted` / `payment.failed` → `subscriptions.status = 'past_due'`.
- `subscription.cancelled` → `subscriptions.status = 'canceled'`.
- Any other event → 200, no-op (standard webhook practice: never fail on an
  event you don't handle, or the sender will keep retrying it forever).

This is also what replaces `stubPaymentGateway` with a real
`razorpayGateway: PaymentGateway` — the existing internal
`POST /api/clients/:id/subscription` route (today unused by any frontend,
per earlier findings this session) switches to the real gateway too, so
Probild staff assigning a plan to an existing client manually goes through
the same real billing path as a self-serve signup.

## Razorpay setup (manual, one-time, done in Razorpay's dashboard)

Create 3 recurring Plan objects (Small/Medium/Large — Enterprise has no
Razorpay Plan, it's Contact Us only), monthly, INR, amounts matching
`plans.monthly_fee_inr`. Copy each Plan ID into env vars
(`RAZORPAY_PLAN_ID_SMALL`/`_MEDIUM`/`_LARGE`). Register the webhook URL
(`https://d2c.probild.in/api/webhooks/razorpay`) with the same events listed
above, and copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` come from Razorpay's API Keys
settings.

## Frontend

- `/pricing` — public, fetches `GET /api/plans`, renders the 4 tiers and the
  3 add-on prices from real data, "Get Started" per self-serve tier routes to
  `/signup?plan=<id>`, Enterprise routes to `/contact-enterprise`.
- `/signup` — collects brand name, category, owner name, email, password;
  on submit calls `POST /api/signup`, loads Razorpay's `checkout.js`, opens
  it with the returned `subscription_id`; on the Razorpay success callback,
  calls `POST /api/signup/complete` with the signup form data plus Razorpay's
  response fields; on success, calls `supabase.auth.signInWithPassword` and
  navigates to `/dashboard`.
- `/contact-enterprise` — a plain form posting to `POST /api/enterprise-leads`.
- Existing `/login` is unchanged and already works for returning self-serve
  customers — same Supabase Auth, no new login path.

## Security

- `/api/signup` and `/api/signup/complete` are public — rate-limited using
  the existing `createRateLimiter` factory (`server/src/middleware/rate-limit.ts`),
  the same one already applied to other unauthenticated endpoints (e.g. the
  OAuth connect routes).
- Payment is never trusted from the client alone: provisioning only happens
  after the server independently recomputes and checks Razorpay's signature.
- Passwords are handled entirely by Supabase's Admin API — no custom hashing
  or storage in this app.

## Testing

- `POST /api/signup` / `/complete`: valid flow creates all five rows and a
  working session; invalid signature creates nothing; a mid-provisioning
  failure cleans up the orphaned Supabase user; a duplicate email is rejected
  before any Razorpay call.
- Razorpay webhook: valid signature updates subscription state correctly per
  event type; invalid signature rejected; unknown event types return 200
  without erroring, following the same test shape already used for the
  Shopify/Delhivery/Shiprocket webhook suites.
- `GET /api/plans`: returns real seeded data including the new add-on columns.

## Explicitly out of scope

- Changing plans after signup (the existing admin-only
  `POST /api/clients/:id/subscription` route already supports this; wiring a
  self-serve "change my plan" UI to it is a natural follow-up, not required
  here).
- Buying add-ons (extra Meta/Google accounts, extra Shopify stores) after
  initial signup — prices are shown on `/pricing`, but no purchase flow for
  them is built in this spec.
- Any dunning/retry logic beyond relaying what Razorpay's own webhook events
  report.
- Resolving the Meta/Google/Shopify App Review dependency described above.
