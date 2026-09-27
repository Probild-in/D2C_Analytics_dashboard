# Simple One-Click Integrations: Shopify, Meta, Couriers

Status: Approved for planning
Date: 2026-09-27

## Goal

Make connecting a client's accounts feel like "log in with X" instead of setup work:

- **Shopify**: log in with the store's Shopify account.
- **Meta**: log in with the client's Meta Business Manager and pick ad accounts.
- **Delivery partners** (Shiprocket, Delhivery): connect with the client's courier account
  and get real shipment/RTO/NDR data on the Operations page.

Builds on the shipped foundation (Supabase auth, `platform_connections`, encrypted
credentials, connector registry, state tokens, node-cron sync). Google Ads is already
OAuth; it moves into the same UI but its backend flow is unchanged.

## Findings from current provider docs (Context7, 2026-09-27)

- **Meta**: Facebook Login for Business with a *Configuration Set* (access-token type,
  asset types, permissions) is Meta's recommended way for platforms to act on behalf of
  clients. Context7 did not return the `config_id` login-dialog parameter details; these
  are verified against Meta's docs while writing plan 4, not assumed here.
- **Shiprocket**: no OAuth. `POST /v1/external/auth/login` with an API user's `email` and
  `password` returns a bearer token. Tracking via `GET /v1/external/track/{order_id}`;
  tracking webhooks exist.
- **Delhivery**: no OAuth. API-token auth. Context7 only holds an overview page for the
  B2C API; exact tracking endpoints and status codes are confirmed from Delhivery's
  developer portal while writing plan 3.
- **Shopify**: the existing connector already uses the documented authorization-code
  flow with HMAC verification. Context7 returned only Shopify's customer/Shop login docs,
  not the Admin API install docs, so the install-link behavior in plan 5 is confirmed from
  shopify.dev when that plan is written.

"Login with a delivery partner" therefore means a small credentials form validated live
against the courier, not a redirect. The UX goal (one dialog, instant success/failure) is
the same.

## Non-goals

- Real-time courier webhooks (sync stays polling, per the earlier specs).
- Creating shipments or booking pickups from the dashboard. Read-only tracking data only.
- Couriers other than Shiprocket and Delhivery (Shadowfax stays "coming soon"). The
  interface makes adding one a single-file change.
- Matching a Shopify order's tracking number to a Delhivery shipment beyond the
  `tracking_company ilike '%delhivery%'` heuristic (no fuzzy/alias matching).
- Multi-fulfillment orders: only the first fulfillment's tracking number is captured.
- Buying additional connection add-ons; existing limit enforcement is unchanged.
- Changing how Google Ads connects.

## Architecture

### Connector framework

`Connector` (in `server/src/integrations/types.ts`) gains:

```ts
authType: "oauth" | "credentials";
// credentials connectors only:
connectWithCredentials?(
  clientId: string,
  credentials: Record<string, string>,
): Promise<{
  externalAccountId: string;
  accessToken: string;
  expiresAt?: Date;
  // secrets the connector needs later (e.g. Shiprocket email+password for re-login);
  // the route stores them encrypted in platform_connections.credentials
  credentials?: Record<string, string>;
}>;
```

`getAuthUrl`/`handleCallback` become optional (present only for `oauth`). The registry
keeps one entry per platform key.

New platform keys: `courier_shiprocket`, `courier_delhivery` (existing naming; Shadowfax's
key remains but is not connectable).

### Routes

- Existing, unchanged: `POST /clients/:id/connections/:platform/authorize`,
  `GET /integrations/:platform/callback`, `GET /clients/:id/connections`.
- New: `POST /clients/:id/connections/:platform/connect` for `credentials` platforms.
  Flow: `assertClientAccess` → connector `connectWithCredentials` (live validation against
  the provider) → upsert `platform_connections` → respond with the connection summary.
  A connector signals bad credentials by throwing `CredentialsRejectedError` (message is
  shown to the user, HTTP 400); any other failure is logged and returned as a generic 502.
  Account-limit checks stay inside each connector (the existing pattern: Meta/Google do it
  in `handleCallback`); couriers have no plan limit today.
- New: `DELETE /clients/:id/connections/:platform` (disconnect: sets `status =
  'disconnected'`, keeps historical synced data).
- Credentials are never returned by any endpoint.

### Data model (migration 006)

- Extend the `platform_connections.platform` check constraint with `courier_shiprocket`.
- Add `platform_connections.credentials text` (nullable): AES-256-GCM encrypted JSON blob
  via the existing `encryptToken`. Used by Shiprocket to hold email + password so the
  connector can re-login when its ~10-day token expires (same lazy-refresh-on-401 pattern
  as the Google connector). Delhivery stores its API token in `access_token` and leaves
  `credentials` null.
- `external_account_id`: Shiprocket = API user email; Delhivery = the account/client name
  if the API returns one, otherwise a short non-secret fingerprint of the token (first 8
  hex chars of its SHA-256).
- New table `shipments` (migration 007, plan 2):
  - `id`, `client_id`, `connection_id` (FKs, cascade), `awb`, `order_ref` (the courier's
    reference for the merchant order; stored for a future match against `shopify_orders`),
    `courier_name`, `status` (one of the existing `OrderStatus` values), `destination_state`,
    `ordered_at`, `delivered_at`, `synced_at`; `unique (connection_id, awb)`. (Earlier
    drafts listed `shipped_at`, `rto_at`, `last_event_at`; dropped as unsourced/YAGNI.)
- New table `pending_connections` (plan 4/5 only): `id`, `platform`, `team_member_id`,
  `payload` (encrypted JSON: token + candidate accounts / shop), `expires_at` (30 min).
  Lets a flow pause for a user choice (ad-account picker, "which client owns this store")
  without holding a token in the browser.

### Courier status mapping

Each courier connector owns a `mapStatus(raw): OrderStatus` with an exhaustive table plus
a safe fallback of "In Transit" for unknown non-terminal codes (logged, not thrown), like
the Meta status mapping. The frontend `OrderStatus` enum does not change.

### Courier sync

Hourly node-cron job per courier platform through the existing `runScheduledSyncs`
(same error isolation and `sync_logs`). Each sync:

1. Determine the window: orders created in the last 30 days (the connector pages through
   the courier's newest-first order list and stops at the first page that is entirely
   older than the window, or at a hard page cap). Non-terminal shipments older than the
   window are not re-polled (accepted gap).
2. Upsert one `shipments` row per shipment (AWB) with the mapped status.
3. Update `platform_connections.last_synced_at` (never resurrecting a disconnected row).

### Operations page

- New `GET /clients/:id/couriers/summary?days=N` (`:id` may be `all`): `{ connected,
  statusCounts, couriers[] }` aggregated from `shipments` for the last N days, where each
  courier has orders, delivered, RTO %, NDR % and average delivery days (null when
  unknown). Replaces the mocked `getCourierBreakdown` in `operations.tsx`; the delivery
  funnel and NDR KPI also read `statusCounts` when a courier is connected.
- `GET /clients/:id/sales` computes `rto_orders` per day from `shipments` when the
  client(s) have any shipments (attributed to the order date), so every RTO number in the
  app (KPIs, trend, dashboard) becomes real. Clients with no shipments keep today's
  Shopify-derived value.
- Deviation from earlier drafts: the "orders endpoint prefers shipment status where
  `order_ref` matches a Shopify order" overlay is deferred. The key that links a courier
  order to a Shopify order (Shopify order id vs number/name) cannot be confirmed without
  real data, and Operations no longer needs it because it reads shipments directly.
- When no courier is connected, the courier panel shows an empty state with a "Connect a
  delivery partner" link instead of mock data.

## Per-platform connect flows

### Shopify (plan 1, then plan 5)

- **Plan 1, domain field**: one input. Accepts `mystore`, `mystore.myshopify.com`,
  `https://mystore.myshopify.com/...`, or `admin.shopify.com/store/mystore`; normalizes to
  `mystore.myshopify.com` on the server (single source of truth, testable with the
  existing server test runner) and validates with the existing regex. The frontend sends
  the raw text. Pressing Enter connects. Then the existing redirect → Shopify login/approve →
  callback flow.
- **Plan 5, install link**: `GET /integrations/shopify/install?shop=&hmac=&...` verifies
  the HMAC, then starts OAuth with a state token that has no `clientId`. The callback
  stores the token in `pending_connections` and redirects to
  `#/connect/claim?pending=<id>`, where the logged-in user picks which client the store
  belongs to. `POST /connections/claim` then creates the connection (with limit check) and
  deletes the pending row.

### Meta (plan 4)

- `getAuthUrl` switches to Facebook Login for Business: login dialog with `config_id`
  (new env `META_LOGIN_CONFIG_ID`), `response_type=code`, existing redirect URI and state.
  The exact parameter set is confirmed against Meta docs in the plan.
- `handleCallback` exchanges the code for a token (long-lived, or system-user token if the
  configuration set is created that way; preferred because it does not expire, decided in
  the plan), then lists the granted ad accounts.
- 1 account granted: connect it directly. More than 1: store candidates in
  `pending_connections`, redirect to `#/connect/pick-accounts?pending=<id>`, user selects,
  each selection goes through the existing account-limit check.
- Documented one-time setup for the operator: create the Configuration Set in the Meta
  dashboard, set `META_LOGIN_CONFIG_ID`.

### Shiprocket (plan 2)

- Form: API user email + password (helper text: "Create an API user in Shiprocket →
  Settings → API"). `connectWithCredentials` calls `/v1/external/auth/login`; success
  returns the token (stored encrypted in `access_token`) and credentials (whitelisted to
  email + password) are stored encrypted in `credentials`. Token lifetime is unconfirmed
  (a Shiprocket SDK documents 24 hours), so each sync logs in fresh instead of tracking
  expiry; rejected stored credentials put the connection in `error` (card: Reconnect).
- Sync pages through `GET /v1/external/orders` (each order carries its shipments/AWBs) and
  does not call per-AWB tracking; `mapStatus` maps Shiprocket status labels (e.g.
  `IN TRANSIT`, `PICKED UP`, `RTO INITIATED`, `RTO DELIVERED`, NDR variants, `DELIVERED`)
  to `OrderStatus`, with a logged fallback to "In Transit" for unknown labels.
- The response shapes (list envelope, field names, date formats, status labels, sort
  order) are NOT confirmed by any documentation reachable from Context7 or the docs site
  (JS-rendered); they are isolated in one module and validated at runtime, and must be
  confirmed against a real Shiprocket API user before plan 2 counts as "done".

### Shopify tracking-number capture (plan 3, prerequisite for Delhivery)

- **Confirmed by Context7** (Shopify Admin REST API, `orders.json` resource): each order's
  `fulfillments[]` array carries `tracking_company`, `tracking_number`,
  `tracking_numbers[]`, `tracking_url`, `status`, `shipment_status`. The existing Shopify
  sync (`server/src/integrations/shopify.ts`) already fetches full order bodies with no
  `fields=` filter, so this data is already in every response — it is only not parsed yet.
- Migration 009 adds `shopify_orders.tracking_number text` and
  `shopify_orders.tracking_company text` (nullable), populated from the FIRST fulfillment
  in `fulfillments[]` (accepted gap: a multi-fulfillment order only captures one courier's
  tracking number).

### Delhivery (plan 3)

- **Not sourced from Context7.** Every query against Delhivery's docs (track API, fetch
  waybill, serviceability, NDR, status codes) returned only the developer portal's
  marketing overview page — no endpoint path, field name, or status vocabulary is
  confirmed anywhere. This section is written from general, publicly-known conventions
  about Delhivery's track-by-waybill API (token header auth, `Status`/`StatusType` fields
  on a tracked shipment) and is **unconfirmed training knowledge, not documented fact** —
  a materially higher-risk starting point than Shiprocket's plan 2, where Context7 at
  least confirmed the login and orders-list endpoints. Isolated to
  `server/src/integrations/delhivery-api.ts` and `delhivery-status.ts`, defensively
  parsed exactly like the Shiprocket modules, and this plan is explicitly NOT considered
  safe to rely on for real numbers until verified against a real Delhivery account or
  real documentation — more so than plan 2's own checklist required.
- **No bulk order-discovery endpoint is known to exist.** Unlike Shiprocket's
  `GET /orders`, nothing confirms a "list my shipments" call for Delhivery. Connecting
  Delhivery by itself would sync nothing. Its shipments are instead discovered from the
  Shopify tracking-number capture above: for a client with a connected `courier_delhivery`
  connection, sync reads `shopify_orders` rows where
  `tracking_company ilike '%delhivery%' and tracking_number is not null` (best-effort
  string match — a merchant might type "Delhivery Surface", "DL", or something else this
  misses; accepted gap) and tracks each `tracking_number` as an AWB, capped per sync run.
- Form: a single API token field (helper text pointing at the Delhivery portal, with a
  caveat that connecting only validates the token's *shape*, not that it works — see
  below).
- `connectWithCredentials` does **not** call Delhivery live (no endpoint is confirmed to
  validate against): it accepts any non-blank token, stores it encrypted, and the first
  sync reveals whether it actually works — an auth failure there puts the connection in
  `error` (card: Reconnect), the same outcome a live check would have produced, just one
  sync cycle later. This is a deliberate, documented deviation from every other
  credentials connector in this app (Shiprocket does validate live), because pretending
  to validate against a guessed endpoint would be worse than being honest that it can't
  be checked yet.
- `mapStatus` (in `delhivery-status.ts`) maps assumed status labels onto `OrderStatus`
  with the same "unknown → In Transit, logged once per sync" fallback as Shiprocket.

## Frontend

- New `IntegrationCard` component (one per platform) replaces the three copy-pasted
  `*ConnectButton` implementations in `manage-clients.tsx`. Props: platform metadata,
  connection (or none), `onConnect`, `onDisconnect`.
- New Integrations panel in `ClientDetailDialog`: cards for Shopify, Meta, Google,
  Shiprocket, Delhivery. Each shows status (Connected / Needs attention / Not connected),
  last synced time, and one action: Connect, Reconnect, or Disconnect.
- OAuth platforms: Connect → POST `/authorize` → `window.location` to provider.
  Credential platforms: Connect opens a small dialog with the form, submit is disabled
  until valid, live errors from the server shown inline, closes on success. The dialog
  ships with plan 2, its first consumer; plan 1 builds only the OAuth card path.
- Handles the `?connection=success|error&message=` return params (already emitted by the
  callback) with a toast/banner.
- Plan 4/5 add two pages: `connect/pick-accounts` and `connect/claim`.

## Error handling

- Provider rejects credentials/OAuth: user-readable message, no connection row created.
- Account limit reached: existing 403 message shown on the card.
- Sync failure: connection goes to `error` (card shows "Needs attention" + Reconnect),
  next scheduled run retries, as today.
- Pending connection expired: page shows "This link expired, please connect again".
- Courier token expiry (Shiprocket): silent re-login; if the stored password is no longer
  valid the connection goes to `error` and the card asks for new credentials.

## Security

- Passwords/tokens encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`; never logged and
  never returned to the browser.
- OAuth state stays a signed 10-minute JWT; `pending_connections` rows expire in 30
  minutes and are single-use.
- Shopify install route verifies HMAC before doing anything else.
- Credential connect endpoint requires auth and `assertClientAccess`, and is rate limited
  per user to blunt credential-stuffing use.

## Testing

- Unit tests per connector against mock provider HTTP servers: success, rejected
  credentials, token-expiry re-login, status mapping table (every mapped code + unknown
  fallback).
- Route tests: `/connect` (auth, access, limit, bad credentials, success), disconnect,
  claim/pick-accounts (expiry, single use, limit).
- Frontend: the repo has no frontend test runner and this design does not add one.
  Frontend changes are verified with `npm run build` (type-check), `npm run lint`, and a
  manual run-through of each card state; logic worth unit-testing lives on the server.
- **Manual end-to-end** on real accounts before each integration is "done": real Shopify
  store (both flows), real Meta Business Manager with more than one ad account, a real
  Shiprocket API user, a real Delhivery token. Not automatable; same bar as prior plans.

## Rollout: one spec, five plans

1. **Connector framework + Integrations panel + Shopify domain polish.** Migration 006
   (constraint + `credentials` column), `authType`, `/connect` and disconnect routes,
   `IntegrationCard`, Shopify input normalization, replace duplicated buttons.
2. **Shiprocket + shipments + Operations.** `shipments` table, connector, hourly sync,
   courier breakdown endpoint, Operations wired (removes `getCourierBreakdown` mock),
   orders overlay.
3. **Delhivery** connector on the same shipments plumbing, plus the Shopify
   tracking-number capture it depends on for shipment discovery (migration 009).
4. **Meta Login for Business + ad-account picker** (`pending_connections`).
5. **Shopify install-link flow** (reuses `pending_connections`).

Plans 1 and 2 unblock real courier data soonest; plans 4 and 5 add polish to already
working connections, so they go last.

## Prerequisites / operator setup

- Meta: Configuration Set created in the Meta dashboard, `META_LOGIN_CONFIG_ID` set
  (plan 4).
- Shopify: app URL set to the install route for the install-link flow (plan 5).
- A real Shiprocket API user and Delhivery API token for manual end-to-end verification.
