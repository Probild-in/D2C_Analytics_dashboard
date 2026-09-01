# Backend v1: Auth, Billing, and Multi-Platform Integrations

Status: Approved for planning
Date: 2026-08-31

## Goal

Replace the deterministic mock data layer (`src/data/mock.ts`) with a real backend: real
agency team login, a real client/plan/billing data model, and real "connect your account"
integrations for Shopify, Meta Ads, and Google Ads. Courier integrations and real payment
collection are built as extension points but stay stubbed until credentials for a specific
courier and a payment gateway exist.

## Non-goals (this build)

- Real payment collection (Razorpay or otherwise) — no gateway account exists yet. A
  gateway-agnostic interface is built and stubbed; wiring a real gateway in is a later,
  separate task.
- A working courier integration — the connect UI and backend interface exist for couriers,
  but every courier shows as "Coming soon" until real API credentials for at least one
  courier are available.
- Multi-agency / white-label support — the current UI models exactly one agency managing
  multiple clients; that assumption carries into the backend unchanged.
- Meta `ads_management` write scope — this is a read-only reporting dashboard, so only
  `ads_read` is requested, avoiding Meta's longer app-review process for management scopes.

## Architecture

**Approach A (modular monolith)**, confirmed with the user over alternatives (a separate
worker service; per-integration Supabase Edge Functions):

- One Node.js/Express API server, deployed on Railway.
- Supabase provides the Postgres database and Supabase Auth (agency team login/sessions).
  The API server connects to Supabase's Postgres directly for all application data and
  verifies Supabase Auth JWTs on every request.
- Each integration (Shopify, Meta, Google, Courier) is a module implementing one shared
  interface: `getAuthUrl()`, `handleCallback()`, `sync()`, `disconnect()`. Adding a real
  courier later means implementing this interface for that courier — nothing else changes.
- Sync jobs run on a schedule (node-cron) inside the same API process. Revisit a separate
  worker service (Approach B) only if scheduled syncing measurably slows down live
  dashboard requests — not expected at agency-dashboard scale (a handful of clients,
  hourly-ish syncs).

## Data model

### Team & access (Supabase Auth-backed)

- `auth.users` — Supabase's own table; handles login/sessions.
- `team_members` — `id` (= `auth.users.id`), `name`, `email`, `role`
  (`owner | manager | marketer | team_member`), `all_client_access boolean`.
- `team_member_clients` — join table (`team_member_id`, `client_id`) for scoped access when
  `all_client_access` is false. Mirrors the existing Manage Clients page exactly (Owner =
  all-access, others scoped to specific clients).

### Clients / brands

- `clients` — `id`, `name`, `category`, `logo_color`, `logo_initial`, `owner_id`,
  `created_at`. Same shape as the current `CLIENTS` array in `mock.ts`, so it's a mechanical
  swap on the frontend. `status` (healthy/attention/critical) is **not** a stored column —
  it's computed at query time from RTO%/ROAS thresholds against the client's real order
  data, same "raw in, computed on read" principle as the rest of the metrics below.

### Billing

- `plans` — seeded once from the agreed pricing table:

  | name | order_limit | monthly_fee_inr | included_meta_accounts | included_google_accounts |
  |---|---|---|---|---|
  | Small | 300 | 1499 | 1 | 1 |
  | Medium | 1500 | 2999 | 2 | 2 |
  | Large | 5000 | 5999 | 4 | 4 |
  | Enterprise | null (custom) | 9999+ (custom) | custom | custom |

  Add-on unit prices (not per-plan, apply to any plan): extra Meta account ₹499/mo, extra
  Google Ads account ₹499/mo, extra Shopify store (same brand) ₹999/mo.

- `subscriptions` — one per client: `plan_id`, `status`
  (`active | past_due | canceled | trialing`), `current_period_start/end`,
  `extra_shopify_stores`, `extra_meta_accounts`, `extra_google_accounts`,
  `gateway_customer_id` (null until a real gateway is wired in).
- `invoices` — `subscription_id`, `amount_inr`, `status` (all `pending` until a real
  gateway exists — this is the exact seam a real gateway plugs into later),
  `period_start/end`, `gateway_payment_id` (nullable).

### Integrations — one unified table for all four platforms

- `platform_connections` — `client_id`, `platform`
  (`shopify | meta | google | courier_delhivery | courier_shadowfax | ...`), `status`
  (`connected | disconnected | error`), `access_token` + `refresh_token` (encrypted at
  rest, app-level AES-256-GCM, key in Railway env — never returned to the frontend),
  `token_expires_at`, `external_account_id` (shop domain / ad account id / etc.),
  `metadata jsonb` (platform-specific extras, e.g. last error message), `last_synced_at`,
  `connected_by` (FK `team_members`). A client can have **more than one** row for the same
  `platform` (e.g. two `shopify` connections for a brand with an extra store add-on) — there
  is no unique constraint on `(client_id, platform)`, only on `(client_id, platform,
  external_account_id)` to prevent connecting the exact same account twice.
- `sync_logs` — `connection_id`, `started_at`, `finished_at`, `records_synced`, `error`.
  Lightweight run history for debugging — not a full monitoring stack.

### Synced data (raw in, aggregates computed at query time)

Sync jobs write **raw** platform data only. Every metric the current UI computes in
`mock.ts` (RTO %, AOV, product rollups, geography breakdowns, blended ROAS) is computed
from this raw data via SQL at query time — never duplicated into a separately-maintained
"computed" table. This is a deliberate choice: it makes correctness a property of the
query, not something that can drift out of sync with the source data.

- `shopify_orders`, `shopify_order_line_items` — from Shopify's Orders API.
- `meta_campaign_metrics`, `google_campaign_metrics` — daily/per-sync rows from each Ads
  API's reporting endpoints.
- `courier_shipments` — table exists in the schema; no sync job writes to it until a real
  courier is wired up.

## Connect flow (identical shape for all four platforms)

1. Frontend: agency user clicks "Connect Shopify / Meta / Google / Courier" on a client's
   integrations screen.
2. `POST /api/clients/:id/connections/:platform/authorize` — backend builds that platform's
   real OAuth authorize URL (using our registered app credentials for that platform) with a
   signed `state` param encoding `{clientId, platform, teamMemberId}`. Returns the URL.
3. Browser redirects to the platform's own login/consent screen. We never see the user's
   platform password — only the OAuth result.
4. Platform redirects back to `GET /api/integrations/:platform/callback?code=&state=`.
   Backend verifies `state`, exchanges `code` for tokens via the platform's token endpoint,
   encrypts the tokens, and upserts the `platform_connections` row (`status = connected`,
   `external_account_id` from the platform's response).
5. Backend redirects the browser back to the frontend's integrations page with a
   success/error query param; frontend re-fetches connection status.

Platform-specific notes:

- **Shopify**: per-shop OAuth — the user enters their `*.myshopify.com` domain before the
  redirect. Scopes: `read_orders, read_products, read_customers` (read-only).
- **Meta**: standard Facebook Login OAuth dialog. Scope: `ads_read` only (see Non-goals).
- **Google Ads**: standard Google OAuth consent screen. If the agency manages client
  accounts under an MCC, the `login-customer-id` header is required on subsequent API
  calls — resolved during `handleCallback()` by listing accessible customers.
- **Courier**: `getAuthUrl()` returns a "not yet available" state; the picker UI shows every
  courier as "Coming soon." Wiring in a real courier later means implementing the same
  three functions for that courier only.

## Sync jobs

- Each connector exports `sync(connection): Promise<void>` — pulls data since
  `last_synced_at` (incremental where the platform API supports it, e.g. Shopify's
  `updated_at_min`) and upserts into the raw tables.
- One scheduler (node-cron, in-process) runs every connected integration's `sync()` on an
  interval — more frequent for Shopify (order data is time-sensitive) than for ad platforms
  (daily spend reporting is normal cadence).
- A manual "Sync now" action on the frontend calls the same function on demand, rate-limited
  to once per 5 minutes per connection.
- On failure (expired token, API error, rate limit), the connection flips to `status =
  error` with a reason in `metadata`; the UI surfaces a "needs reconnecting" state. Never a
  silent, permanent failure — every failure is visible and actionable.
- Rate-limited platforms (Meta, Google) get exponential backoff within a sync run; a run
  that still fails after backoff is logged to `sync_logs` and the connection marked `error`.

## Billing / plan enforcement

- **Order volume** (`plans.order_limit` vs. real order count for the current billing
  period): never blocks sync — losing real business data over a plan cap would be worse
  than the alternative. Instead surfaces an "over plan limit" flag in the dashboard,
  prompting an upgrade.
- **Ad account / extra-store limits**: enforced as a hard block at the moment of connecting
  a *new* account beyond what the plan + purchased add-ons allow (e.g. "Your plan includes
  2 Meta accounts; add an extra account (₹499/mo) to connect more"). This is a discrete
  action, so blocking it cleanly is straightforward — unlike an ongoing data stream.
- **`PaymentGateway` interface**: `createSubscription()`, `chargeInvoice()`,
  `cancelSubscription()`. The stub implementation marks invoices `pending` and logs; no
  money moves. Plan upgrades/downgrades and add-on purchases already flow through this
  interface, so wiring in a real gateway later is implementing this one interface — nothing
  else in the app changes.

## API surface (replacing `mock.ts` functions 1:1 where possible)

- `GET /api/clients` — replaces the `CLIENTS` array.
- `GET /api/clients/:id/sales`, `/orders`, `/products`, `/geography` — replace
  `getSalesSeries`, `getOrders`, `getProducts`, `getGeoBreakdown`.
- `GET /api/clients/:id/campaigns?platform=meta|google` + `/creatives` — replace
  `getCampaigns`/`getCreatives`, now backed by real synced data.
- `GET/POST /api/clients/:id/connections`, `/connections/:platform/authorize`,
  `GET /api/integrations/:platform/callback` — the connect flow above.
- `GET/POST /api/clients/:id/subscription` — billing.
- `GET/POST /api/tasks` — becomes a **real, persisted** feature (see below).
- Every endpoint requires a Supabase Auth JWT; results are scoped to whichever clients the
  authenticated team member can access (`all_client_access` or the join table).

### Content that becomes real, not synced

Two things in the current mock UI are pure fictional flavor that no platform API provides:
the Meta/Google "campaign review & activity" comment thread (scripted "Client"/"Marketing
Team" back-and-forth), and generic task descriptions ("Auto-generated task description...").
Moving to a real backend, the campaign activity thread becomes actual notes people type
(a real `campaign_notes` table, not synced from Meta/Google), and tasks become whatever the
creator writes. No decision needed here — flagged so the shift from "looks realistic" to
"is real" is explicit going in.

## Error handling

- OAuth callback failures (user denies consent, expired `state`, token exchange failure):
  redirect to the frontend with an error message; connection stays `disconnected`.
- Expired/revoked tokens discovered during sync: mark connection `error`, surface a
  "reconnect" CTA — never silently retry forever.
- All API errors follow one shape (`{ error: { code, message } }`) so the frontend can
  handle them uniformly.

## Testing strategy

- Unit tests per connector module against recorded/fixture API responses (no live calls in
  CI).
- Integration tests for the OAuth callback + token storage flow using a mock OAuth server.
- Billing enforcement tests (order-limit flag, add-on hard blocks) run against seeded
  `plans`/`subscriptions` fixtures.
- Manual end-to-end verification against the real Shopify store, Meta app, and Google Ads
  account already confirmed available, before considering an integration "done."

## Prerequisites confirmed available

- Shopify: a real/dev store.
- Meta: a registered Meta Developer App (App ID + Secret).
- Google Ads: a developer token + OAuth client already provisioned.
- Supabase project (Postgres + Auth) and Railway account for deployment.

## Prerequisites deliberately deferred

- A payment gateway account (Razorpay or otherwise) — blocks real payment collection only;
  everything else (plans, subscriptions, invoices, enforcement) works against the stub.
- Real API credentials for at least one courier — blocks real shipment data only; the
  connect picker and backend interface exist regardless.
