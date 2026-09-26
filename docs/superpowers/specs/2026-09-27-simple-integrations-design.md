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
): Promise<{ externalAccountId: string; accessToken: string; expiresAt?: Date }>;
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
  the provider) → account-limit check → upsert `platform_connections` → respond with the
  connection summary, or a 400 with a user-readable message ("Shiprocket rejected these
  credentials").
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
- New table `shipments`:
  - `id`, `client_id`, `connection_id` (FKs, cascade), `awb`, `order_ref` (the merchant's
    order number/id, used to match `shopify_orders`), `courier_name`, `status` (one of
    the existing `OrderStatus` values), `destination_state`, `shipped_at`,
    `delivered_at`, `rto_at`, `last_event_at`, `synced_at`; `unique (connection_id, awb)`.
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

1. Determine the window: shipments created or updated in the last 30 days, plus any
   non-terminal shipments already stored.
2. Fetch/refresh statuses, upsert into `shipments`.
3. Update `platform_connections.last_synced_at`.

### Operations page

- New `GET /clients/:id/couriers/breakdown`: per-courier counts (shipped, delivered, NDR,
  RTO) and RTO %, aggregated from `shipments` for the selected date range. Replaces the
  mocked `getCourierBreakdown` in `operations.tsx`.
- Where a shipment's `order_ref` matches a Shopify order, the orders endpoint prefers the
  shipment's status and courier over the Shopify-derived guess (Shopify only knows
  fulfilled/unfulfilled). Unmatched orders keep today's behavior.
- When no courier is connected, the courier panel shows an empty state with a "Connect a
  delivery partner" link instead of mock data.

## Per-platform connect flows

### Shopify (plan 1, then plan 5)

- **Plan 1, domain field**: one input. Accepts `mystore`, `mystore.myshopify.com`,
  `https://mystore.myshopify.com/...`, or `admin.shopify.com/store/mystore`; normalizes to
  `mystore.myshopify.com` client-side and re-validates server-side with the existing
  regex. Pressing Enter connects. Then the existing redirect → Shopify login/approve →
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
  returns the token (stored encrypted in `access_token`, expiry ~10 days) and credentials
  are stored encrypted in `credentials`. On a 401 during sync the connector re-logs-in
  once and retries.
- Sync reads the shipments/orders list and per-AWB tracking as needed; `mapStatus` maps
  Shiprocket status labels (e.g. `IN TRANSIT`, `PICKED UP`, `RTO INITIATED`,
  `RTO DELIVERED`, NDR variants, `DELIVERED`) to `OrderStatus`.

### Delhivery (plan 3)

- Form: API token (helper text with where to find it in the Delhivery portal).
  Validation and tracking endpoints, and the status-code table for `mapStatus`, come from
  Delhivery's portal during plan 3.

## Frontend

- New `IntegrationCard` component (one per platform) replaces the three copy-pasted
  `*ConnectButton` implementations in `manage-clients.tsx`. Props: platform metadata,
  connection (or none), `onConnect`, `onDisconnect`.
- New Integrations panel in `ClientDetailDialog`: cards for Shopify, Meta, Google,
  Shiprocket, Delhivery. Each shows status (Connected / Needs attention / Not connected),
  last synced time, and one action: Connect, Reconnect, or Disconnect.
- OAuth platforms: Connect → POST `/authorize` → `window.location` to provider.
  Credential platforms: Connect opens a small dialog with the form, submit is disabled
  until valid, live errors from the server shown inline, closes on success.
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
- Frontend: normalization of Shopify domain input (unit), IntegrationCard state rendering.
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
3. **Delhivery** connector on the same shipments plumbing.
4. **Meta Login for Business + ad-account picker** (`pending_connections`).
5. **Shopify install-link flow** (reuses `pending_connections`).

Plans 1 and 2 unblock real courier data soonest; plans 4 and 5 add polish to already
working connections, so they go last.

## Prerequisites / operator setup

- Meta: Configuration Set created in the Meta dashboard, `META_LOGIN_CONFIG_ID` set
  (plan 4).
- Shopify: app URL set to the install route for the install-link flow (plan 5).
- A real Shiprocket API user and Delhivery API token for manual end-to-end verification.
