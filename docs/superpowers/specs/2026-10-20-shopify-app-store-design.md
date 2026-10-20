# Shopify App Store App — Design

## Goal

Add a third account-acquisition channel: a publicly-listed Shopify App Store app that any
merchant can install directly from Shopify, which automatically creates their account,
connects their Shopify store, and logs them straight into the existing dashboard — no
manual OAuth setup, no password to create.

## Context

This app currently has two ways an account gets created:

1. **Agency-initiated**: staff manually OAuth-connects a client's Shopify store to an
   already-existing `clients` row (`server/src/integrations/shopify.ts`'s
   `shopifyConnector`, used via `server/src/routes/connections.ts` — requires an
   authenticated staff session and a pre-existing `clientId`).
2. **Self-serve via Razorpay** (built earlier, see
   `docs/superpowers/specs/2026-10-15-saas-signup-billing-design.md`): a visitor picks a
   plan on `/pricing`, pays via Razorpay, and `POST /api/signup/complete` provisions the
   account.

Both stay exactly as they are. This spec adds a third path that **neither** of them
covers: a merchant browsing Shopify's own App Store, installing with one click, and
expecting to land inside a working product with zero manual setup — Shopify's own
distribution and review requirements shape almost everything about how this path works.

**Confirmed, binding Shopify platform constraints** (verified against current Shopify
documentation, not assumed):
- Apps distributed through the Shopify App Store **must** bill exclusively through
  Shopify App Pricing or the Shopify Billing API — an external processor (Razorpay) is
  explicitly prohibited for this channel's charges. This does not affect the existing
  Razorpay channel, which isn't going through Shopify's listing.
- Shopify requires: merchants can upgrade/downgrade a plan without contacting support or
  reinstalling, and the app must correctly handle charge approval/decline on reinstall.
- A **separate Shopify Partner app registration** (distribution: Shopify App Store) is
  required, with its own client ID/secret — distinct from whatever Shopify API
  credentials the existing agency-connect flow already uses. Reusing the existing app's
  credentials and just flipping its distribution setting would put the agency-connect
  flow's app under App Store review constraints it was never built for; registering a
  separate Partner app keeps the two completely independent.
- Three GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are
  mandatory for every listed app regardless of what it does.
- Because this app reads order-linked customer names/addresses, Shopify's **protected
  customer data access** review is very likely required as a separate approval gate.

## User-confirmed decisions (binding for this spec)

- **Additional channel, not a replacement** — `/pricing` + Razorpay stays exactly as-is;
  this is a second door in for merchants who discover the product via Shopify's App
  Store.
- **Redirect-out model, not embedded** — the Shopify app's job is install → provision →
  log in → hand off. The merchant's day-to-day dashboard experience is the existing,
  unchanged `d2c.probild.in` — no Polaris, no App Bridge session-token auth for ongoing
  use, no iframe-embedded rebuild of any dashboard screen.
- **Mirrors the existing 4 tiers** — Small/Medium/Large (Enterprise stays Contact-Us-only,
  not purchasable through this channel), same prices and `order_limit` soft-caps as the
  Razorpay plans, configured as 4 matching fixed-price recurring plans via the Shopify
  Billing API.
- **Auto-login via Supabase's own magic-link mechanism** — reuses the existing
  `createSupabaseUser` pattern from the Razorpay signup flow, then generates a one-time
  sign-in link instead of asking for a password.
- **No self-service team invites** — out of scope (this app has no self-service "invite a
  teammate" flow for any channel today; not something this plan introduces either).

## Architecture

### 1. Install flow

`GET /api/shopify-app/install?shop=<shop>.myshopify.com` — the URL Shopify sends a
merchant to when they click "Install." Initiates standard Shopify OAuth against the
**new, separate** Partner app's credentials (`SHOPIFY_APP_STORE_CLIENT_ID`/`_SECRET`),
requesting the scopes needed to read orders/customers (same scopes the existing connector
already uses, read `server/src/integrations/shopify.ts`'s `SHOPIFY_SCOPES` constant for
the exact list) plus `read_customers`/base `shop` access for the owner's contact email.

`GET /api/shopify-app/callback` — Shopify's redirect back. Verifies the HMAC (same
scheme `shopify.ts`'s existing `verifyCallbackHmac` already implements — reuse it, don't
reimplement), exchanges the code for an access token (same token-exchange call
`shopify.ts`'s `handleCallback` already makes — factor the token-exchange+HMAC-verify
logic into a shared helper both the existing connector and this new handler call, rather
than duplicating it), then fetches the shop's own record (`GET
/admin/api/.../shop.json`) for its name and contact `email` (a standard field, no
customer-data scope needed — it's the store's own contact address, not a customer's).

**Idempotency / reinstall:** if `shop` already has a `clients` row (a merchant
uninstalled and reinstalled), do not create a second account — look it up by a new
`clients.shopify_shop_domain` column (see Data model) and re-provision the Shopify
connection / regenerate the login link for the existing account instead of erroring or
duplicating.

### 2. Provisioning (atomic, same discipline as the Razorpay flow)

Inside one DB transaction: create the `client` (named from the shop; `category` is a
`not null` column with no Shopify-provided equivalent — default it to a literal
`"Uncategorized"` placeholder the merchant can edit later via the existing `PATCH
/api/clients/:id` route, rather than guessing at a category from the store's name), the
`team_member` (owner, `account_type =
'self_serve_owner'`, same staff-gating as every other self-serve path), the
`team_member_clients` scoping row, the `platform_connections` row for Shopify itself
(already connected — that's the point, no separate "connect Shopify" step needed), and
the Supabase user (`createSupabaseUser`, reused from the existing self-serve signup
code).

### 3. Plan selection + billing

Shopify App Store installs don't carry a pre-picked plan. Right after provisioning, show
a small plan-picker page (reusing `GET /api/plans`'s existing 4-tier data) inside the
still-open install flow. Once chosen, create the recurring charge via the Shopify Billing
API (`appSubscriptionCreate` GraphQL mutation against the 4 plans configured for this
Partner app) — Shopify shows its own native charge-approval screen, then redirects back
to a confirmation callback, which activates the subscription.

A `subscriptions.billing_provider` column (see Data model) distinguishes a
Shopify-sourced subscription from a Razorpay-sourced one, so the existing Razorpay
webhook handler (`server/src/routes/razorpay-webhooks.ts`) never mistakes a Shopify
charge id for one of its own, and vice versa for a new, separate Shopify billing webhook
handler this plan adds.

### 4. Auto-login + handoff

Once the charge is approved, generate a Supabase magic link for the new user
(`supabase-admin.ts` gains a `generateMagicLink` function alongside the existing
`createSupabaseUser`/`deleteSupabaseUser`) and redirect the merchant's browser straight
through it. They land on `d2c.probild.in/`, already signed in — the existing dashboard,
completely unchanged.

### 5. Mandatory Shopify compliance webhooks

Three new, small, specific routes (not a redesign of anything): `POST
/api/webhooks/shopify-app/customers/data-request`, `.../customers/redact`,
`.../shop/redact` — HMAC-verified using the **new** Partner app's own client secret (not
the existing agency-connect app's), same raw-body-before-`express.json()` mounting
pattern the existing Shopify order webhooks already use. `shop/redact` deletes (or
anonymizes, per Shopify's documented grace-period expectations) the client's data when a
merchant uninstalls and the shop closes; `customers/redact`/`customers/data_request`
handle an individual customer's GDPR request forwarded by Shopify — for this app's
current data model (order-linked customer name/city/state, no separate customer PII
store), this is a lookup-and-delete/export against `shopify_orders` rows matching the
given customer, scoped to the requesting shop.

## Data model changes

```sql
-- New column distinguishing how a client account was acquired, and giving reinstalls a
-- lookup key.
alter table clients add column shopify_shop_domain text unique;

-- New column distinguishing which billing system backs a subscription, so the Razorpay
-- webhook handler and the new Shopify billing webhook handler never cross-process a
-- charge id that belongs to the other system.
alter table subscriptions add column billing_provider text not null default 'razorpay' check (billing_provider in ('razorpay', 'shopify'));
```

## Known external constraints (not solved by this spec)

- Shopify Partner Dashboard app registration (name, icon, listing copy, screenshots,
  privacy policy URL, support contact) is a manual, non-code task the user does directly
  in Shopify Partners — same pattern as the Razorpay Plans being created manually in the
  earlier SaaS billing spec.
- Shopify's protected customer data access review is a separate approval Shopify grants
  or denies outside this app's control, and can gate the whole listing.
- Shopify's general app review timeline/outcome is external and not something this plan
  can guarantee.

## Testing

Standard pattern established across every prior plan this session: unit/integration
tests for the install+callback flow (HMAC verification, token exchange, idempotent
reinstall), the provisioning transaction (atomicity, rollback + Supabase-user cleanup on
failure — same discipline as the Razorpay signup's pay-then-provision tests), the 3
compliance webhooks (signature verification, correct redaction scope), and the billing
webhook handler (billing_provider isolation from the Razorpay handler). No frontend
automated tests (established precedent) — the plan-picker/handoff pages get `npm run
build` + manual verification.

## Explicitly out of scope

- Embedded-in-Shopify-Admin dashboard experience (Polaris, App Bridge session-token auth
  for ongoing use) — explicitly rejected in favor of the redirect-out model.
- Self-service team invites for any channel.
- Usage-based/metered billing via Shopify's App Events API — fixed tiers only, mirroring
  the existing Razorpay plans.
- Plan changes/upgrades/downgrades after initial purchase through this channel (same
  scope boundary the Razorpay signup spec already drew for its own channel).
- Retiring or modifying the existing agency-connect Shopify OAuth flow in any way.
