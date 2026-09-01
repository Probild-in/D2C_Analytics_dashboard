# Real Platform Integrations: Shopify, Meta Ads, Google Ads

Status: Approved for planning
Date: 2026-09-02

## Goal

Replace the remaining mock-data surfaces of the dashboard with real, live-synced data
from Shopify, Meta Ads, and Google Ads — the three integrations the backend foundation
plan deliberately deferred. This covers real OAuth connect flows, real sync jobs, real
campaign/creative data, and real campaign notes, building on the foundation's already-shipped
Supabase Auth, client/billing model, credential encryption, and stubbed `Connector` interface.

Prerequisites confirmed available: a real/dev Shopify store, a registered Meta Developer
App, a Google Ads developer token + OAuth client, and a real public HTTPS domain
(`https://d2c.probild.in`, live on a Hostinger VPS) for OAuth callback URLs.

## Non-goals

- Courier integrations and real payment collection remain stubbed (no change from the
  foundation plan — no courier API credentials or payment gateway account exist yet).
- Buying additional ad-account add-ons (`extra_meta_accounts`/`extra_google_accounts`) —
  those columns exist and are enforced against, but stay at their default of `0` since no
  purchase flow exists yet. Account-limit enforcement in this plan checks against
  `included_*_accounts + extra_*_accounts` as it stands today.
- Real-time webhooks. Sync stays polling-based (in-process `node-cron`), per the
  foundation spec's original decision — revisit only if this measurably matters later.
- Re-hosting ad creative media ourselves. Creative thumbnails/video are referenced by the
  platform's own CDN URL, not downloaded into our own storage.

## Architecture

Extends the foundation's Approach A (single Express server, Supabase for Postgres+Auth) —
no new services, no new deployment target. Three new `Connector` implementations
(`shopify`, `meta`, `google`) plug into the interface the foundation already defined:

```ts
interface Connector {
  platform: string;
  getAuthUrl(clientId: string, state: string): string;
  handleCallback(query): Promise<{ externalAccountId, accessToken, refreshToken?, expiresAt? }>;
  sync(connectionId): Promise<{ recordsSynced: number }>;
  disconnect(connectionId): Promise<void>;
}
```

A plain lookup registry maps platform name to connector instance:

```ts
const connectors: Record<string, Connector> = { shopify, meta, google };
```

Two generic dispatch routes — explicitly deferred by the foundation plan since there was
no real connector to route to yet — are built now:

```
POST /api/clients/:id/connections/:platform/authorize
GET  /api/integrations/:platform/callback
```

`authorize` resolves the connector from the registry and returns `getAuthUrl()`'s result.
`callback` verifies a signed `state` token, resolves the connector, calls
`handleCallback()`, encrypts the returned tokens with the foundation's existing
`crypto.ts`, and upserts `platform_connections`.

### State parameter signing

`state` is a short-lived (~10 minute) signed token encoding
`{ clientId, platform, teamMemberId }`, using a new `STATE_SIGNING_SECRET` env var
(separate from `SUPABASE_JWT_SECRET` — different purpose, different blast radius if
either leaks). This is what prevents a forged callback from attaching a stolen OAuth code
to an arbitrary client.

## Data model additions

Three new tables. Nothing in the foundation's existing schema changes.

```sql
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  external_campaign_id text not null,
  name text not null,
  status text not null check (status in ('active', 'paused', 'in review', 'completed')),
  created_at timestamptz not null default now(),
  unique (connection_id, external_campaign_id)
);

create table campaign_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  external_creative_id text not null,
  name text not null,
  format text not null,
  headline text,
  primary_text text,
  cta text,
  thumbnail_url text,
  status text not null,
  spend integer not null,
  impressions integer not null,
  clicks integer not null,
  results integer not null,
  hook_rate numeric,
  hold_rate numeric,
  launched_date date,
  synced_at timestamptz not null default now(),
  unique (campaign_id, external_creative_id)
);

create table campaign_notes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  author_id uuid not null references team_members(id),
  body text not null,
  created_at timestamptz not null default now()
);
```

`campaigns` is the identity layer the existing `meta_campaign_metrics`/
`google_campaign_metrics` tables never had — those keep their existing shape (one row per
campaign per day, keyed by `external_campaign_id` text) for aggregation; `campaigns` is
joined on that same id when assembling the full campaign view for the frontend.

## Connect flow — per-platform specifics

Follows the foundation spec's 5-step connect flow shape exactly (frontend clicks Connect
→ `authorize` → platform's own login screen → `callback` → redirect back with
success/error). Platform-specific details:

- **Shopify**: the connect UI needs one small addition — a text field for the merchant's
  `*.myshopify.com` domain, entered before redirecting (Shopify OAuth is per-shop).
  Scopes: `read_orders, read_products, read_customers`. Tokens don't expire under normal
  use (only on app uninstall), so `refresh_token` stays null for this connector.
- **Meta**: standard Facebook Login dialog, `ads_read` scope only (no `ads_management` —
  this is a read-only reporting dashboard). **Account-limit enforcement happens inside
  `handleCallback`**, before the connection is upserted: count existing `connected` Meta
  connections for the client, compare against
  `plan.included_meta_accounts + subscription.extra_meta_accounts`; over the limit throws
  a 403 and no connection is created.
- **Google**: standard OAuth consent screen. `handleCallback` additionally lists
  accessible customers to resolve the `login-customer-id` needed for later API calls
  (agencies typically manage client accounts under an MCC), stored in `metadata jsonb`.
  Same account-limit check as Meta, against `included_google_accounts`.

## Sync jobs

Each connector's `sync(connectionId)`:

- **Shopify**: incremental pull via `updated_at_min` since `last_synced_at`, upserts
  `shopify_orders` and `shopify_order_line_items`.
- **Meta / Google**: pulls campaigns (upsert `campaigns`), daily insights (upsert the
  existing metrics tables), and ad creatives (upsert `campaign_creatives`, joined to
  `campaigns` by `external_campaign_id`).

**Token refresh**: lazy, on-demand. A sync run that hits an auth error from the platform
API attempts one `refresh_token`-based refresh and retries; still failing flips
`platform_connections.status` to `'error'` with the reason in `metadata` and logs to
`sync_logs`. No separate scheduled refresh job.

**Scheduling**: in-process `node-cron` — hourly for Shopify, every 6 hours for Meta/Google.
Plus the existing manual "Sync now" action, rate-limited to once per 5 minutes per
connection.

**Rate limits**: Meta/Google API rate limits get exponential backoff within a single sync
run before the run is logged as failed.

## Error handling

Follows the foundation's standard `{ "error": { "code", "message" } }` shape throughout.

- OAuth callback failures (consent denied, expired/tampered `state`, token exchange
  failure, account-limit exceeded) redirect the browser back to the frontend with an
  error query param; the connection is never created, or stays `disconnected`.
- A sync failure (after the one refresh-and-retry) marks the connection `error` and
  surfaces a "needs reconnecting" state on the frontend — never a silent permanent
  failure.

## Testing strategy

- Unit tests per connector against recorded fixture API responses — no live platform
  calls in the test suite, matching the foundation plan's own testing principles.
- Integration tests for the callback → token-encryption → `platform_connections` upsert
  flow, using a mock OAuth server.
- Account-limit enforcement gets explicit tests: at-limit succeeds, over-limit 403s and no
  connection row is created.
- **Manual end-to-end verification** against the real Shopify dev store, Meta app, and
  Google Ads account is required before considering each integration "done" — this can't
  be automated and is the same bar the foundation plan held itself to.

## Rollout: one spec, three plans

This single design covers the shared architecture (registry, dispatch routes, data model,
account-limit pattern) so it gets built once. Implementation still splits into three
separate, independently-reviewable task plans, executed in this order via the same
subagent-driven-development process used for the foundation:

1. **Shopify** — builds the shared registry/dispatch-route plumbing alongside its own
   connector, since nothing exists yet for either. Unblocks the most pages (Sales,
   Products, Geography, Operations), so it goes first.
2. **Meta Ads** — adds its connector to the now-existing registry, plus `campaigns`,
   `campaign_creatives`, and `campaign_notes` for the Meta Ads page.
3. **Google Ads** — same pattern as Meta, for the Google Ads page.
