# Meta Ads Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/pages/meta-ads.tsx`'s mock campaign/creative/activity data with a real Meta Ads connector — OAuth connect, scheduled sync of campaigns/insights/creatives, and real campaign notes — following the shared architecture the Shopify plan already built (connector registry, generic `/authorize`/`/callback` dispatch routes, signed state, encrypted token storage).

**Architecture:** A `meta` `Connector` implementation added to the existing `connectors` registry (`server/src/lib/connector-registry.ts`). Three new tables (`campaigns`, `campaign_creatives`, `campaign_notes`) join to the foundation's existing `meta_campaign_metrics` table (kept in its current shape, per the design spec) via `external_campaign_id`. Account-limit enforcement (`included_meta_accounts + extra_meta_accounts`) happens inside `handleCallback`, before any connection row is created. Sync pulls campaigns, daily insights, and ad creatives from Meta's Graph Marketing API; scheduled every 6 hours via a second `node-cron` job alongside Shopify's hourly one.

**Tech Stack:** Same as the Shopify plan — Express/TypeScript backend, Postgres via `pg`, React/TypeScript frontend, `useClientResource` for data fetching, `vitest`/`supertest` for backend tests with `vi.stubGlobal("fetch", ...)` fixtures (no live Meta API calls in tests).

**Spec:** `docs/superpowers/specs/2026-09-02-platform-integrations-design.md` — this plan implements that spec's Meta Ads section and its shared architecture, already built by the Shopify plan (`docs/superpowers/plans/2026-09-02-shopify-integration.md`).

## Global Constraints

- Standard `{error:{code,message}}` shape for every error response (project-wide, already enforced by the global Express error handler).
- Access tokens encrypted via the existing `server/src/lib/crypto.ts` (`encryptToken`/`decryptToken`) before storage, exactly as Shopify's tokens are.
- OAuth callback failures redirect with an error query param and never leave a half-created `platform_connections` row.
- Account-limit enforcement happens inside `handleCallback`, BEFORE the connection upsert — over-limit throws and no row is created, matching the spec's explicit ordering.
- No live Meta API calls in any test file — `vi.stubGlobal("fetch", ...)` fixtures only, following every existing test in this codebase.
- `meta_campaign_metrics` keeps its existing column shape (`client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results, synced_at`) — per the spec, nothing about this table changes. It has no revenue/conversion-value column, so per-campaign ROAS is NOT computable from real data yet; the frontend's `roas` field is hardcoded to `0` until a future pass adds Meta's `purchase_roas` insights field to this table. This mirrors the Shopify plan's own precedent (RTO/courier fields stubbed at `0` pending a courier integration that doesn't exist yet) — a documented gap, not a bug.
- The mock activity feed's `"response"`/`"status"`/`"creative"`/`"budget"` entry types have no real backend equivalent in the spec (only `campaign_notes`, i.e. genuine user-authored notes). The real implementation shows ONLY real notes — no fabricated system narrative. This is a deliberate simplification, not a partial implementation: manufacturing fake "status changed" events to fill out an activity feed would be exactly the kind of fake data the whole plan exists to remove.
- `hook_rate`/`hold_rate` on `campaign_creatives` are nullable (`numeric`) — Meta's Insights API only returns these for video creatives (video-specific retention metrics), so image/carousel creatives will have `null` here. The frontend must render these as absent/dash, not `0`, when null.
- Manual end-to-end verification against the real Meta Developer App and a real Meta Ads account is required before considering this plan done — this can't be automated, same bar the Shopify plan held itself to.
- **Token refresh, corrected from the spec's generic "lazy refresh on 401" pattern:** Facebook Login's standard authorization-code exchange (what `handleCallback` performs in Task 2) does not return a `refresh_token` — Meta's OAuth model has no distinct refresh-token grant. The access token it returns is already the long-lived kind (~60 days, reflected in `expires_in`/`expiresAt`); there is nothing to exchange it for once it expires except a brand-new user login through the same `/dialog/oauth` flow. So: `handleCallback` never returns a `refreshToken` (the field stays `undefined`, which the existing `platform_connections` upsert in `integrations.ts` already handles — it stores `null` when absent, unchanged from how Shopify's connector behaves). When `sync()` hits a 401/expired-token error from the Graph API, it cannot retry-after-refresh (there is no refresh path) — it must fall straight to the existing generic failure handling already built by the Shopify plan (`scheduler.ts`'s per-connection catch flips `status` to `'error'` and logs to `sync_logs`), which surfaces "needs reconnecting" on the frontend exactly as the spec's own error-handling section describes for an unrecoverable failure. No new code is needed for this — it is what already happens today when `sync()` throws for any reason — this note exists so no task in this plan is written expecting a refresh path that doesn't exist for this platform.
- **Rate-limit backoff is explicitly OUT of scope for this plan**, despite the design spec mentioning it ("Meta/Google API rate limits get exponential backoff within a single sync run"). Task 4's `sync()` treats a rate-limited response the same as any other non-2xx (throws, connection flips to `'error'`, one manual "Sync now" click recovers it). Real exponential backoff needs its own retry-loop design and its own tests (simulating a 429 that succeeds on the Nth attempt without a live API call is a meaningfully different testing problem than anything else in this plan) — matching the Shopify plan's own precedent of deferring its comparably-sized pagination gap to a dedicated follow-up rather than folding it into an already-large task. Track as a follow-up task once this plan's core connect/sync/display loop is verified working end-to-end.

## File Structure

- Create: `server/migrations/004_campaign_tables.sql` — `campaigns`, `campaign_creatives`, `campaign_notes` tables.
- Create: `server/src/integrations/meta.ts` — the `meta` connector (`getAuthUrl`/`handleCallback`/`sync`/`disconnect`).
- Modify: `server/src/lib/connector-registry.ts` — register `meta`.
- Modify: `server/src/scheduler.ts` — add a 6-hourly cron entry for `meta`, generalizing `runScheduledSyncs` (already takes a `platform` param, no change needed there) with a second `cron.schedule` call.
- Create: `server/src/routes/campaigns.ts` — `GET /api/clients/:id/campaigns?platform=meta`, `GET /api/clients/:id/campaigns/:campaignId/creatives`, `GET`/`POST /api/clients/:id/campaigns/:campaignId/notes`.
- Modify: `server/src/index.ts` — mount the new campaigns router.
- Modify: `server/.env.example` — document `META_APP_ID`, `META_APP_SECRET`.
- Modify: `src/pages/meta-ads.tsx` — rewire from `mock.ts`'s `getCampaigns`/`getCampaignActivity` to `useClientResource`.
- Modify: `src/components/dashboard/creatives-panel.tsx` — `CreativesGrid` takes a `creatives: Creative[]` prop instead of deriving from mock data internally.
- Modify: `src/pages/manage-clients.tsx` — generalize `ConnectionsPanel` to show a connect button per platform (Shopify's shop-domain flow unchanged; Meta gets a plain "Connect Meta Ads" button, no extra input).
- Modify: `src/data/types.ts` — `Creative.thumbnailColor` (mock-only cosmetic field) becomes `Creative.thumbnailUrl` (real CDN reference, per the spec's "reference the platform's own CDN URL" decision); `Campaign.thumbnailColor`/`thumbnail` similarly become optional, since the real campaigns table has no thumbnail field at all (campaigns aren't visual objects on Meta the way creatives are — only creatives have images/video).

---

### Task 1: Migration — campaigns, campaign_creatives, campaign_notes

**Files:**
- Create: `server/migrations/004_campaign_tables.sql`
- Test: `server/test/helpers/test-db.ts` already applies every migration file in the directory automatically (confirmed in the Shopify plan's Task 1) — no test file changes needed, but Step 2 below verifies this explicitly for the new tables.

**Interfaces:**
- Consumes: nothing new.
- Produces: `campaigns(id, client_id, connection_id, external_campaign_id, name, status, created_at)`, `campaign_creatives(id, campaign_id, external_creative_id, name, format, headline, primary_text, cta, thumbnail_url, status, spend, impressions, clicks, results, hook_rate, hold_rate, launched_date, synced_at)`, `campaign_notes(id, campaign_id, author_id, body, created_at)` — exact shape from the design spec, copied verbatim below. Every later task in this plan reads/writes these three tables.

- [ ] **Step 1: Write the migration**

```sql
-- server/migrations/004_campaign_tables.sql
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

create index campaigns_client_idx on campaigns (client_id);
create index campaign_creatives_campaign_idx on campaign_creatives (campaign_id);
create index campaign_notes_campaign_idx on campaign_notes (campaign_id);
```

The three indexes aren't in the spec's own SQL block but are added here directly (not as a
later fix-round patch) — the Shopify plan shipped without indexes on its own read-heavy
tables and needed a follow-up migration to add them once the final review caught the
missing-index issue. Every one of `campaigns`/`campaign_creatives`/`campaign_notes` is
queried by exactly the foreign key indexed here (client_id, campaign_id, campaign_id) in
every task below, so add them now rather than repeat that mistake.

- [ ] **Step 2: Verify the migration applies cleanly**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```

Expected: all existing tests still pass (this migration adds tables, touches nothing
existing) — `resetTestDb()` applies this file automatically as part of every test's
`beforeEach`, so a syntax error here would fail every single test, not just new ones.

- [ ] **Step 3: Commit**

```bash
git add server/migrations/004_campaign_tables.sql
git commit -m "feat(server): add campaigns, campaign_creatives, campaign_notes tables"
```

---

### Task 2: Meta connector — getAuthUrl, handleCallback, account-limit enforcement

**Files:**
- Create: `server/src/integrations/meta.ts`
- Test: `server/test/integrations/meta.test.ts`

**Interfaces:**
- Consumes: `Connector` interface (`server/src/integrations/types.ts`, unchanged), `encryptToken`/`decryptToken` (`server/src/lib/crypto.ts`, unchanged).
- Produces: `metaConnector: Connector`. Task 3 registers it; Task 6 calls `metaConnector.sync`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/integrations/meta.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { metaConnector } from "../../src/integrations/meta.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

beforeEach(() => {
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("metaConnector.getAuthUrl", () => {
  it("builds a Facebook Login dialog URL with ads_read scope", () => {
    const url = metaConnector.getAuthUrl("abc-fashion", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.facebook.com");
    expect(parsed.pathname).toBe("/v21.0/dialog/oauth");
    expect(parsed.searchParams.get("client_id")).toBe("test-app-id");
    expect(parsed.searchParams.get("scope")).toBe("ads_read");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/meta/callback");
  });
});

describe("metaConnector.handleCallback", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into plans (id, name, monthly_fee_inr, included_meta_accounts, included_google_accounts) values
       ('starter', 'Starter', 5000, 1, 1)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, extra_meta_accounts) values
       ('abc-fashion', 'starter', 'active', 0)`,
    );
  });

  it("exchanges the code for an access token and resolves the ad account id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "fb-real-token", token_type: "bearer", expires_in: 5184000 }), { status: 200 });
        }
        if (url.includes("/me/adaccounts")) {
          return new Response(JSON.stringify({ data: [{ id: "act_123456789", name: "ABC Fashion Ads" }] }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const result = await metaConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" });
    expect(result.externalAccountId).toBe("act_123456789");
    expect(result.accessToken).toBe("fb-real-token");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid request", { status: 400 })));
    await expect(metaConnector.handleCallback({ code: "bad-code" }, { clientId: "abc-fashion" })).rejects.toThrow();
  });

  it("throws if the account has no ad accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "fb-real-token", expires_in: 5184000 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    await expect(metaConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/ad account/i);
  });

  it("throws when the client is already at its Meta account limit", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, access_token, external_account_id) values
       ('abc-fashion', 'meta', 'connected', 'x', 'act_existing')`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "fb-real-token", expires_in: 5184000 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: "act_new", name: "New Account" }] }), { status: 200 });
      }),
    );
    await expect(metaConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/limit/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- meta.test.ts
```

Expected: FAIL — `server/src/integrations/meta.ts` doesn't exist yet.

- [ ] **Step 3: Extend the Connector interface for the account-limit context**

The account-limit check needs `clientId` inside `handleCallback`, but the existing
`Connector` interface (`server/src/integrations/types.ts`) only passes `query`. Modify it:

```typescript
// server/src/integrations/types.ts
export interface Connector {
  platform: string;
  getAuthUrl(clientId: string, state: string): string;
  handleCallback(query: Record<string, string>, context: { clientId: string }): Promise<{
    externalAccountId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;
  sync(connectionId: string): Promise<{ recordsSynced: number }>;
  disconnect(connectionId: string): Promise<void>;
}
```

This is a real, deliberate interface change (not additive-only) — `handleCallback`'s second
parameter is new and required. Task 4 updates the ONE existing caller (Shopify's connector
via `server/src/routes/integrations.ts`) and Shopify's own `handleCallback` implementation
to accept (and ignore) this new parameter, so the whole codebase compiles consistently. Do
NOT make `context` optional — an optional second parameter that Shopify's implementation
silently ignores while Meta's requires it is a worse design than requiring every connector
to declare the parameter, even if only Meta reads it.

- [ ] **Step 4: Write the connector**

```typescript
// server/src/integrations/meta.ts
import type { Connector } from "./types.js";
import pool from "../db.js";

const META_API_VERSION = "v21.0";
const META_SCOPES = "ads_read";

function getRedirectUri(): string {
  const publicApiUrl = process.env.PUBLIC_API_URL;
  if (!publicApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${publicApiUrl}/api/integrations/meta/callback`;
}

function getCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID and META_APP_SECRET environment variables must be set");
  }
  return { appId, appSecret };
}

async function assertUnderMetaAccountLimit(clientId: string): Promise<void> {
  const result = await pool.query(
    `select
       coalesce(p.included_meta_accounts, 0) + coalesce(s.extra_meta_accounts, 0) as limit,
       (select count(*) from platform_connections where client_id = $1 and platform = 'meta' and status = 'connected') as current_count
     from subscriptions s
     join plans p on p.id = s.plan_id
     where s.client_id = $1`,
    [clientId],
  );
  if (result.rowCount === 0) {
    // No subscription row at all means no Meta accounts are provisioned for this client.
    throw new Error("This client has no active subscription — cannot connect a Meta account");
  }
  const { limit, current_count: currentCount } = result.rows[0];
  if (Number(currentCount) >= Number(limit)) {
    throw new Error(`Meta account limit reached (${limit} account(s) included on this client's plan)`);
  }
}

export const metaConnector: Connector = {
  platform: "meta",

  getAuthUrl(_clientId: string, state: string): string {
    const { appId } = getCredentials();
    const url = new URL(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("scope", META_SCOPES);
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>, context: { clientId: string }) {
    const code = query.code;
    if (!code) {
      throw new Error("Meta callback missing code query parameter");
    }
    await assertUnderMetaAccountLimit(context.clientId);

    const { appId, appSecret } = getCredentials();
    const tokenParams = new URLSearchParams({
      client_id: appId,
      redirect_uri: getRedirectUri(),
      client_secret: appSecret,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?${tokenParams}`);
    if (!tokenRes.ok) {
      throw new Error(`Meta token exchange failed: ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token: string; expires_in?: number };

    const adAccountsRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/me/adaccounts?fields=id,name&access_token=${tokenBody.access_token}`,
    );
    if (!adAccountsRes.ok) {
      throw new Error(`Meta ad accounts fetch failed: ${adAccountsRes.status}`);
    }
    const adAccountsBody = (await adAccountsRes.json()) as { data: { id: string; name: string }[] };
    if (adAccountsBody.data.length === 0) {
      throw new Error("No Meta ad account is accessible with this login — the user must have at least one ad account");
    }

    return {
      externalAccountId: adAccountsBody.data[0].id,
      accessToken: tokenBody.access_token,
      expiresAt: tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000) : undefined,
    };
  },

  async sync(_connectionId: string) {
    // Implemented in Task 4.
    return { recordsSynced: 0 };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
```

`getAuthUrl`'s first parameter is unused here (Shopify's implementation uses it as the shop
domain; Meta's login dialog has no per-connection input to embed) — prefixed with `_` to
signal this deliberately, matching this codebase's existing convention for unused
parameters (see `_req` patterns elsewhere).

Note the account-limit query joins `subscriptions` to `plans` to compute
`included_meta_accounts + extra_meta_accounts` and compares against a live count of
`connected` Meta rows for the client — this is the exact ordering the spec requires
("BEFORE the connection is upserted"), and it runs inside `handleCallback` itself (not the
generic `integrations.ts` route), so it naturally applies no matter which route calls this
connector.

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- meta.test.ts
```

Expected: PASS.

- [ ] **Step 6: Fix the Shopify connector and its caller for the new Connector interface**

`server/src/integrations/shopify.ts`'s `handleCallback` signature must accept (and ignore)
the new second parameter:

```typescript
// change:
async handleCallback(query: Record<string, string>) {
// to:
async handleCallback(query: Record<string, string>, _context: { clientId: string }) {
```

`server/src/routes/integrations.ts` must pass `{ clientId: statePayload.clientId }` as the
second argument:

```typescript
// change:
const { externalAccountId, accessToken, refreshToken, expiresAt } = await connector.handleCallback(query);
// to:
const { externalAccountId, accessToken, refreshToken, expiresAt } = await connector.handleCallback(query, {
  clientId: statePayload.clientId,
});
```

Run the FULL suite (not just this task's own tests) to confirm this interface change
didn't break Shopify's existing passing tests:

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```

Expected: every test passes, including Shopify's `handleCallback` tests (which call it with
only one argument in their own test file — TypeScript will need those call sites updated
too if `context` isn't optional; find them with
`grep -rn "handleCallback(" server/test/` and add `, { clientId: "abc-fashion" }` to each).

- [ ] **Step 7: Run `tsc` to confirm the interface change is fully consistent**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors. A dangling call site using the old one-argument signature would show
up here even if some test happens to still pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/integrations/meta.ts server/src/integrations/types.ts server/src/integrations/shopify.ts server/src/routes/integrations.ts server/test/integrations/meta.test.ts server/test/integrations/shopify.test.ts
git commit -m "feat(server): add Meta connector OAuth (getAuthUrl, handleCallback, account-limit enforcement)"
```

---

### Task 3: Register the Meta connector; add META_APP_ID/META_APP_SECRET

**Files:**
- Modify: `server/src/lib/connector-registry.ts`
- Modify: `server/.env.example`
- Test: `server/test/routes/connections.test.ts` (append)

**Interfaces:**
- Consumes: `metaConnector` (Task 2).
- Produces: `connectors.meta` — Task 4's sync route and the frontend's `/authorize` calls for `platform=meta` both resolve through this registry entry, identically to how Shopify's already does.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/connections.test.ts` (inside the existing
`describe("POST /:platform/authorize", ...)` block if one exists, otherwise as a new
`it` alongside the existing Shopify authorize tests):

```typescript
  it("resolves the meta connector and returns an authorizeUrl", async () => {
    process.env.META_APP_ID = "test-app-id";
    process.env.META_APP_SECRET = "test-app-secret";
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/meta/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("facebook.com");
  });
```

(Read the existing test file first to match its exact `beforeEach` fixture — it already
seeds `abc-fashion` and a `riya@agency.com` owner with `all_client_access`, per every other
test file in this codebase.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- connections.test.ts
```

Expected: FAIL — 404 `unknown_platform` (meta isn't registered yet).

- [ ] **Step 3: Register the connector**

```typescript
// server/src/lib/connector-registry.ts
import { shopifyConnector } from "../integrations/shopify.js";
import { metaConnector } from "../integrations/meta.js";
import type { Connector } from "../integrations/types.js";

export const connectors: Record<string, Connector> = {
  shopify: shopifyConnector,
  meta: metaConnector,
};
```

- [ ] **Step 4: Document the new env vars**

Append to `server/.env.example` (following the existing file's own comment style):

```bash
# Meta (Facebook) app credentials — from developers.facebook.com, used for the Meta Ads
# OAuth connect flow (ads_read scope only, no ads_management).
META_APP_ID=...
META_APP_SECRET=...
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- connections.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/connector-registry.ts server/.env.example server/test/routes/connections.test.ts
git commit -m "feat(server): register meta connector, document META_APP_ID/SECRET"
```

---

### Task 4: Meta connector sync — campaigns, insights, creatives

**Files:**
- Modify: `server/src/integrations/meta.ts`
- Test: `server/test/integrations/meta.test.ts` (append)

**Interfaces:**
- Consumes: `campaigns`/`campaign_creatives`/`meta_campaign_metrics` tables (Task 1 + foundation plan).
- Produces: real `metaConnector.sync()` — Task 5's scheduler and the existing generic
  `POST /:platform/sync` route (already built by the Shopify plan, fully generic) both call
  this unchanged.

- [ ] **Step 1: Write the failing test**

Append to `server/test/integrations/meta.test.ts`:

```typescript
describe("metaConnector.sync", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    const { encryptToken } = await import("../../src/lib/crypto.js");
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'meta', 'connected', $1, 'act_123456789')`,
      [encryptToken("fb-real-token")],
    );
  });

  it("upserts campaigns, daily insights, and creatives from the Marketing API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/campaigns?")) {
          return new Response(
            JSON.stringify({ data: [{ id: "camp_1", name: "Diwali Sale", status: "ACTIVE" }] }),
            { status: 200 },
          );
        }
        if (url.includes("/insights?")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  campaign_id: "camp_1",
                  campaign_name: "Diwali Sale",
                  date_start: "2026-09-01",
                  spend: "499.50",
                  impressions: "10000",
                  clicks: "250",
                  actions: [{ action_type: "omni_purchase", value: "12" }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/ads?")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "ad_1",
                  name: "Diwali Carousel",
                  campaign_id: "camp_1",
                  status: "ACTIVE",
                  created_time: "2026-08-15T00:00:00+0000",
                  creative: {
                    id: "creative_1",
                    object_type: "CAROUSEL",
                    title: "50% Off Everything",
                    body: "Shop the Diwali sale now",
                    call_to_action_type: "SHOP_NOW",
                    thumbnail_url: "https://scontent.example.com/creative_1.jpg",
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/insights") && url.includes("ad_1")) {
          return new Response(
            JSON.stringify({ data: [{ spend: "120.00", impressions: "3000", clicks: "80", actions: [{ action_type: "omni_purchase", value: "4" }] }] }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await metaConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(1);

    const campaigns = await testPool.query("select * from campaigns where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(campaigns.rowCount).toBe(1);
    expect(campaigns.rows[0]).toMatchObject({ external_campaign_id: "camp_1", name: "Diwali Sale", status: "active" });

    const metrics = await testPool.query("select * from meta_campaign_metrics where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(metrics.rowCount).toBe(1);
    expect(metrics.rows[0]).toMatchObject({ campaign_id: "camp_1", spend: 500, impressions: 10000, clicks: 250, results: 12 });

    const creatives = await testPool.query(
      "select * from campaign_creatives where campaign_id = $1",
      [campaigns.rows[0].id],
    );
    expect(creatives.rowCount).toBe(1);
    expect(creatives.rows[0]).toMatchObject({
      external_creative_id: "creative_1",
      name: "Diwali Carousel",
      format: "CAROUSEL",
      headline: "50% Off Everything",
      cta: "SHOP_NOW",
      thumbnail_url: "https://scontent.example.com/creative_1.jpg",
      status: "active",
      spend: 120,
      impressions: 3000,
      clicks: 80,
      results: 4,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- meta.test.ts
```

Expected: FAIL — `sync()` is still the Task 2 stub returning `{recordsSynced: 0}`.

- [ ] **Step 3: Implement sync()**

Replace the stub `sync` in `server/src/integrations/meta.ts`:

```typescript
import { decryptToken } from "../lib/crypto.js";

interface MetaCampaign {
  id: string;
  name: string;
  status: string;
}

interface MetaInsightRow {
  campaign_id: string;
  campaign_name: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: { action_type: string; value: string }[];
}

interface MetaAd {
  id: string;
  name: string;
  campaign_id: string;
  status: string;
  created_time: string;
  creative: {
    id: string;
    object_type: string;
    title?: string;
    body?: string;
    call_to_action_type?: string;
    thumbnail_url?: string;
  };
}

// Meta's core statuses (ACTIVE/PAUSED/...) map onto this narrower enum the way Shopify's
// financial_status/fulfillment_status map onto the order-status enum — deliberately lossy,
// not a bug. Anything not recognized falls back to "paused" rather than throwing, since
// Meta's status vocabulary is broader than what this dashboard displays (e.g. ARCHIVED,
// DELETED, WITH_ISSUES all collapse to "paused" — the safest default: not shown as
// actively spending).
function mapCampaignStatus(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "active";
  if (s === "IN_PROCESS" || s === "PENDING_REVIEW") return "in review";
  if (s === "COMPLETED") return "completed";
  return "paused";
}

// Extracts the purchase count from Meta Insights' `actions` array, which lists every
// action type (link clicks, video views, purchases, ...) the ad drove — we only care
// about purchases for the "results" metric this dashboard shows.
function extractPurchases(actions: { action_type: string; value: string }[] | undefined): number {
  const purchase = actions?.find((a) => a.action_type === "omni_purchase" || a.action_type === "purchase");
  return purchase ? Math.round(parseFloat(purchase.value)) : 0;
}

function getRedirectUri(): string { /* unchanged, already defined above */ }
```

(That last `getRedirectUri` line is a reminder the function already exists earlier in the
file — don't redefine it.)

Now the actual `sync` implementation:

```typescript
  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, external_account_id from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);
    const adAccountId = conn.external_account_id;

    const campaignsRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/campaigns?fields=id,name,status&access_token=${accessToken}`,
    );
    if (!campaignsRes.ok) {
      throw new Error(`Meta campaigns fetch failed: ${campaignsRes.status}`);
    }
    const campaignsBody = (await campaignsRes.json()) as { data: MetaCampaign[] };

    let recordsSynced = 0;
    for (const campaign of campaignsBody.data) {
      const campaignRow = await pool.query(
        `insert into campaigns (client_id, connection_id, external_campaign_id, name, status)
         values ($1, $2, $3, $4, $5)
         on conflict (connection_id, external_campaign_id)
         do update set name = excluded.name, status = excluded.status
         returning id`,
        [conn.client_id, connectionId, campaign.id, campaign.name, mapCampaignStatus(campaign.status)],
      );
      const campaignRowId = campaignRow.rows[0].id;
      recordsSynced++;

      const insightsRes = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${campaign.id}/insights?fields=campaign_id,campaign_name,spend,impressions,clicks,actions&access_token=${accessToken}`,
      );
      if (!insightsRes.ok) {
        throw new Error(`Meta insights fetch failed for campaign ${campaign.id}: ${insightsRes.status}`);
      }
      const insightsBody = (await insightsRes.json()) as { data: MetaInsightRow[] };
      for (const row of insightsBody.data) {
        await pool.query(
          `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results)
           values ($1, $2, $3, $4, current_date, $5, $6, $7, $8)
           on conflict (connection_id, campaign_id, metric_date)
           do update set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks, results = excluded.results`,
          [
            conn.client_id,
            connectionId,
            row.campaign_id,
            row.campaign_name,
            Math.round(parseFloat(row.spend)),
            Math.round(parseFloat(row.impressions)),
            Math.round(parseFloat(row.clicks)),
            extractPurchases(row.actions),
          ],
        );
      }

      const adsRes = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${campaign.id}/ads?fields=id,name,campaign_id,status,created_time,creative{id,object_type,title,body,call_to_action_type,thumbnail_url}&access_token=${accessToken}`,
      );
      if (!adsRes.ok) {
        throw new Error(`Meta ads fetch failed for campaign ${campaign.id}: ${adsRes.status}`);
      }
      const adsBody = (await adsRes.json()) as { data: MetaAd[] };
      for (const ad of adsBody.data) {
        const adInsightsRes = await fetch(
          `https://graph.facebook.com/${META_API_VERSION}/${ad.id}/insights?fields=spend,impressions,clicks,actions&access_token=${accessToken}`,
        );
        if (!adInsightsRes.ok) {
          throw new Error(`Meta ad insights fetch failed for ad ${ad.id}: ${adInsightsRes.status}`);
        }
        const adInsightsBody = (await adInsightsRes.json()) as { data: MetaInsightRow[] };
        const adMetrics = adInsightsBody.data[0];

        await pool.query(
          `insert into campaign_creatives
             (campaign_id, external_creative_id, name, format, headline, primary_text, cta, thumbnail_url, status, spend, impressions, clicks, results, launched_date)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           on conflict (campaign_id, external_creative_id)
           do update set name = excluded.name, status = excluded.status, spend = excluded.spend,
             impressions = excluded.impressions, clicks = excluded.clicks, results = excluded.results`,
          [
            campaignRowId,
            ad.creative.id,
            ad.name,
            ad.creative.object_type,
            ad.creative.title ?? null,
            ad.creative.body ?? null,
            ad.creative.call_to_action_type ?? null,
            ad.creative.thumbnail_url ?? null,
            mapCampaignStatus(ad.status),
            adMetrics ? Math.round(parseFloat(adMetrics.spend)) : 0,
            adMetrics ? Math.round(parseFloat(adMetrics.impressions)) : 0,
            adMetrics ? Math.round(parseFloat(adMetrics.clicks)) : 0,
            adMetrics ? extractPurchases(adMetrics.actions) : 0,
            ad.created_time.slice(0, 10),
          ],
        );
      }
    }

    await pool.query("update platform_connections set last_synced_at = now(), status = 'connected' where id = $1", [connectionId]);
    return { recordsSynced };
  },
```

`recordsSynced` counts campaigns (not creatives/insight-rows) — matching Shopify's own
`sync()`, which counts orders (the top-level entity), not line items. `status='connected'`
on the final update is included from the start here (not added in a later fix round) —
the Shopify plan's final review found a stuck-`'error'`-status bug that this avoids by
building the recovery-on-success behavior in from day one.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- meta.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite and tsc**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test && npx tsc --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/meta.ts server/test/integrations/meta.test.ts
git commit -m "feat(server): implement Meta connector sync (campaigns, insights, creatives)"
```

---

### Task 5: Scheduler — add Meta's 6-hourly sync

**Files:**
- Modify: `server/src/scheduler.ts`
- Test: `server/test/scheduler.test.ts` (append)

**Interfaces:**
- Consumes: `runScheduledSyncs(platform: string)` (already generic, unchanged — built by
  the Shopify plan specifically so this task needs no changes to that function itself).
- Produces: nothing new — just a second `cron.schedule` registration.

- [ ] **Step 1: Write the failing test**

Append to `server/test/scheduler.test.ts`:

```typescript
import cron from "node-cron";

describe("startScheduler", () => {
  it("schedules both the hourly Shopify sync and the 6-hourly Meta sync", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("0 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    expect(scheduleSpy).toHaveBeenCalledWith("0 */6 * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });
});
```

(Add `startScheduler` to this test file's existing import from `../src/scheduler.js`.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- scheduler.test.ts
```

Expected: FAIL — only one `cron.schedule` call happens today.

- [ ] **Step 3: Add the second schedule**

```typescript
export function startScheduler() {
  cron.schedule(
    "0 * * * *",
    () => {
      runScheduledSyncs("shopify").catch((err) => console.error("Shopify scheduled sync failed:", err));
    },
    { noOverlap: true },
  );

  // Meta's Insights API updates less frequently than Shopify's order stream and is far
  // more rate-limit-sensitive (this connector's sync makes 3 API calls per campaign, plus
  // 1 per ad) — 6-hourly keeps well clear of Meta's per-app rate limits even for a client
  // with dozens of active campaigns.
  cron.schedule(
    "0 */6 * * *",
    () => {
      runScheduledSyncs("meta").catch((err) => console.error("Meta scheduled sync failed:", err));
    },
    { noOverlap: true },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/scheduler.ts server/test/scheduler.test.ts
git commit -m "feat(server): schedule Meta sync every 6 hours"
```

---

### Task 6: Real read endpoints — GET campaigns, GET creatives, GET/POST notes

**Files:**
- Create: `server/src/routes/campaigns.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/routes/campaigns.test.ts`

**Interfaces:**
- Consumes: `campaigns`/`campaign_creatives`/`campaign_notes`/`meta_campaign_metrics` (Task 1).
- Produces:
  - `GET /api/clients/:id/campaigns?platform=meta` → array matching `src/data/types.ts`'s
    `Campaign` shape MINUS `thumbnail`/`thumbnailColor` (dropped — see Global Constraints;
    campaigns have no visual asset of their own on Meta, only creatives do) and with
    `roas` hardcoded to `0`.
  - `GET /api/clients/:id/campaigns/:campaignId/creatives` → array matching `Creative`
    shape, with `thumbnailUrl` (not `thumbnailColor`) and `roas` hardcoded to `0` (same
    reasoning as campaigns — no revenue data to compute it from yet).
  - `GET /api/clients/:id/campaigns/:campaignId/notes` → array of
    `{id, campaignId, author, timestamp, message}` (mapped from `campaign_notes` joined to
    `team_members` for the author's display name).
  - `POST /api/clients/:id/campaigns/:campaignId/notes` → creates a note authored by the
    requesting team member, returns it in the same shape. Task 9 (frontend) is the only
    consumer of all four.

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes/campaigns.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'meta', 'connected', 'act_123')`,
  );
  await testPool.query(
    `insert into campaigns (id, client_id, connection_id, external_campaign_id, name, status) values
     ('66666666-6666-6666-6666-666666666666', 'abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp_1', 'Diwali Sale', 'active')`,
  );
  await testPool.query(
    `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
     ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp_1', 'Diwali Sale', current_date, 500, 10000, 250, 12),
     ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp_1', 'Diwali Sale', current_date - 1, 300, 6000, 150, 8)`,
  );
  await testPool.query(
    `insert into campaign_creatives (id, campaign_id, external_creative_id, name, format, headline, cta, thumbnail_url, status, spend, impressions, clicks, results, hook_rate) values
     ('77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666666', 'creative_1', 'Diwali Carousel', 'CAROUSEL', '50% Off', 'SHOP_NOW', 'https://cdn.example.com/x.jpg', 'active', 120, 3000, 80, 4, 32.5)`,
  );
});

describe("GET /api/clients/:id/campaigns", () => {
  it("returns campaigns with metrics summed across all synced days", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns?platform=meta")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "66666666-6666-6666-6666-666666666666",
      name: "Diwali Sale",
      status: "Active",
      spend: 800,
      impressions: 16000,
      clicks: 400,
      results: 20,
      roas: 0,
    });
    expect(res.body[0].ctr).toBeCloseTo((400 / 16000) * 100, 1);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns?platform=meta")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/clients/:id/campaigns/:campaignId/creatives", () => {
  it("returns creatives for the campaign", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/creatives")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: "Diwali Carousel",
      format: "CAROUSEL",
      thumbnailUrl: "https://cdn.example.com/x.jpg",
      status: "Active",
      hookRate: 32.5,
      holdRate: null,
      roas: 0,
    });
  });
});

describe("GET/POST /api/clients/:id/campaigns/:campaignId/notes", () => {
  it("returns an empty array with no notes, then the created note after posting", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const listBefore = await request(app)
      .get("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`);
    expect(listBefore.status).toBe(200);
    expect(listBefore.body).toEqual([]);

    const created = await request(app)
      .post("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Great CTR this week, let's scale budget." });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ author: "Riya Kapoor", message: "Great CTR this week, let's scale budget." });

    const listAfter = await request(app)
      .get("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`);
    expect(listAfter.body).toHaveLength(1);
  });

  it("400s for an empty note body", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- campaigns.test.ts
```

Expected: FAIL — 404 (route file doesn't exist / isn't mounted).

- [ ] **Step 3: Write the route file**

```typescript
// server/src/routes/campaigns.ts
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

const CAMPAIGN_STATUS_DISPLAY: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  "in review": "In Review",
  completed: "Completed",
};

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const platform = req.query.platform === "google" ? "google" : "meta";
    const metricsTable = platform === "google" ? "google_campaign_metrics" : "meta_campaign_metrics";

    const result = await pool.query(
      `select
         c.id, c.name, c.status,
         coalesce(sum(m.spend), 0)::int as spend,
         coalesce(sum(m.impressions), 0)::int as impressions,
         coalesce(sum(m.clicks), 0)::int as clicks,
         coalesce(sum(m.results), 0)::int as results
       from campaigns c
       join platform_connections pc on pc.id = c.connection_id
       left join ${metricsTable} m on m.campaign_id = c.external_campaign_id and m.connection_id = c.connection_id
       where c.client_id = $1 and pc.platform = $2
       group by c.id, c.name, c.status
       order by spend desc`,
      [clientId, platform],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        clientId,
        platform,
        name: r.name,
        status: CAMPAIGN_STATUS_DISPLAY[r.status] ?? "Paused",
        spend: r.spend,
        results: r.results,
        resultType: "Purchases",
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
        cpm: r.impressions > 0 ? (r.spend / r.impressions) * 1000 : 0,
        roas: 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/:campaignId/creatives", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const campaignId = req.params.campaignId;

    const result = await pool.query(
      `select cc.* from campaign_creatives cc
       join campaigns c on c.id = cc.campaign_id
       where cc.campaign_id = $1 and c.client_id = $2
       order by cc.spend desc`,
      [campaignId, clientId],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        campaignId,
        name: r.name,
        format: r.format,
        headline: r.headline ?? "",
        primaryText: r.primary_text ?? "",
        cta: r.cta ?? "",
        thumbnailUrl: r.thumbnail_url,
        status: CAMPAIGN_STATUS_DISPLAY[r.status] ?? "Paused",
        spend: r.spend,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
        results: r.results,
        roas: 0,
        hookRate: r.hook_rate !== null ? Number(r.hook_rate) : null,
        holdRate: r.hold_rate !== null ? Number(r.hold_rate) : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/:campaignId/notes", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const campaignId = req.params.campaignId;

    const result = await pool.query(
      `select cn.id, cn.body, cn.created_at, tm.name as author_name
       from campaign_notes cn
       join campaigns c on c.id = cn.campaign_id
       join team_members tm on tm.id = cn.author_id
       where cn.campaign_id = $1 and c.client_id = $2
       order by cn.created_at asc`,
      [campaignId, clientId],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        campaignId,
        author: r.author_name,
        authorRole: "marketing",
        message: r.body,
        timestamp: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:campaignId/notes", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const campaignId = req.params.campaignId;

    const body = (req.body as { body?: string }).body;
    if (!body || !body.trim()) {
      throw new HttpError(400, "invalid_body", "body is required");
    }

    const inserted = await pool.query(
      `insert into campaign_notes (campaign_id, author_id, body)
       select $1, $2, $3 where exists (select 1 from campaigns where id = $1 and client_id = $4)
       returning id, body, created_at`,
      [campaignId, req.auth!.userId, body.trim(), clientId],
    );
    if (inserted.rowCount === 0) {
      throw new HttpError(404, "not_found", "Campaign not found");
    }

    const authorResult = await pool.query("select name from team_members where id = $1", [req.auth!.userId]);
    res.status(201).json({
      id: inserted.rows[0].id,
      campaignId,
      author: authorResult.rows[0].name,
      authorRole: "marketing",
      message: inserted.rows[0].body,
      timestamp: inserted.rows[0].created_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

The `notes` POST route's `insert ... select ... where exists` pattern does the
campaign-belongs-to-this-client check and the insert in one round trip, atomically —
avoids a separate SELECT-then-INSERT race and naturally 404s (via `rowCount === 0`) for a
campaign id that doesn't belong to `clientId`, without a second query.

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, alongside the existing `shopifyDataRouter`/`connectionsRouter`
mounts:

```typescript
import campaignsRouter from "./routes/campaigns.js";
// ...
app.use("/api/clients/:id/campaigns", campaignsRouter);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- campaigns.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full suite and tsc**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test && npx tsc --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/campaigns.ts server/src/index.ts server/test/routes/campaigns.test.ts
git commit -m "feat(server): add real campaigns, creatives, and notes endpoints"
```

---

### Task 7: Frontend types — Campaign/Creative shape changes

**Files:**
- Modify: `src/data/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the corrected `Campaign`/`Creative` shapes every later frontend task in this
  plan (and the existing mock-data-backed pages still using them, if any remain) compiles
  against.

- [ ] **Step 1: Update the types**

Replace:

```typescript
export interface Campaign {
  id: string;
  clientId: string;
  platform: "meta" | "google";
  name: string;
  status: "Active" | "Paused" | "In Review" | "Completed";
  spend: number;
  results: number;
  resultType: string;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  thumbnail: string;
  thumbnailColor: string;
  startDate: string;
}
```

with:

```typescript
export interface Campaign {
  id: string;
  clientId: string;
  platform: "meta" | "google";
  name: string;
  status: "Active" | "Paused" | "In Review" | "Completed";
  spend: number;
  results: number;
  resultType: string;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
}
```

`reach`/`thumbnail`/`thumbnailColor`/`startDate` are dropped — not stubbed at 0/empty, DROPPED
entirely. `reach` isn't in `meta_campaign_metrics`'s columns (only impressions/clicks/spend/
results — reach would need its own Insights field and column this plan doesn't add).
`thumbnail`/`thumbnailColor` were cosmetic mock-only fields with no real per-campaign visual
asset on Meta (campaigns don't have images — only creatives, one level down, do).
`startDate` has no equivalent either (`campaigns.created_at` is when OUR row was created by
a sync, not when the ad campaign itself started on Meta — presenting that as "startDate"
would be actively misleading, not just incomplete). Task 9 removes every reference to these
four fields from `meta-ads.tsx`.

Replace:

```typescript
export interface Creative {
  id: string;
  campaignId: string;
  name: string;
  format: "Image" | "Video" | "Carousel";
  headline: string;
  primaryText: string;
  cta: string;
  thumbnailColor: string;
  status: "Active" | "Paused";
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  results: number;
  roas: number;
  hookRate?: number;
  holdRate?: number;
```

with:

```typescript
export interface Creative {
  id: string;
  campaignId: string;
  name: string;
  format: string;
  headline: string;
  primaryText: string;
  cta: string;
  thumbnailUrl: string | null;
  status: "Active" | "Paused";
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  results: number;
  roas: number;
  hookRate: number | null;
  holdRate: number | null;
```

`format` widens from a closed union (`"Image" | "Video" | "Carousel"`) to `string` — Meta's
real `object_type` values (`"CAROUSEL"`, `"VIDEO"`, `"SINGLE_IMAGE"`, and others this
dashboard hasn't previously modeled) don't cleanly map to the old three-value mock enum, and
inventing a mapping table to force-fit them would lose information for no benefit (the
frontend only ever displays this string as a label, per the existing
`<span>{c.format}</span>` in `creatives-panel.tsx` — it's never branched on). `hookRate`/
`holdRate` become nullable (not optional-undefined) to match how Postgres actually returns
an absent numeric column via `pg` (`null`, not `undefined`) — `?:` vs `| null` matters here
because `campaign_creatives.hook_rate`/`hold_rate` are genuinely `null` for non-video
creatives, not merely unset in the TS sense.

- [ ] **Step 2: Run tsc to see every call site this breaks**

```bash
cd /tmp/d2c-live && npx tsc --noEmit -p tsconfig.app.json
```

Expected: errors in `src/data/mock.ts` (the fixture data using the old shape) and
`src/pages/meta-ads.tsx`/`src/components/dashboard/creatives-panel.tsx` (consumers). Do NOT
fix these yet — Task 8 and Task 9 do that. This step exists so the NEXT task's implementer
starts from a known, complete list of what needs fixing rather than discovering it
piecemeal. Copy the full error list into this task's report.

- [ ] **Step 3: Commit**

```bash
git add src/data/types.ts
git commit -m "fix(types): correct Campaign/Creative shape to match real Meta data"
```

(Committing with the rest of the codebase temporarily broken is intentional and safe here
— this is a single-session SDD plan where Task 8 lands immediately after, not a
long-lived branch other work might be based on.)

---

### Task 8: CreativesGrid takes creatives as a prop; fix mock.ts

**Files:**
- Modify: `src/components/dashboard/creatives-panel.tsx`
- Modify: `src/data/mock.ts`

**Interfaces:**
- Consumes: `Creative`/`Campaign` (Task 7).
- Produces: `CreativesGrid({ creatives: Creative[] })` — Task 9 is the only real consumer;
  supplies real, fetched creatives instead of having the component derive them internally
  from mock data.

- [ ] **Step 1: Change CreativesGrid's props**

Find (near the top of `creatives-panel.tsx`):

```typescript
export function CreativesGrid({ campaign }: { campaign: Campaign }) {
  const creatives = React.useMemo(() => getCreatives(campaign), [campaign]);
```

Replace with:

```typescript
export function CreativesGrid({ creatives }: { creatives: Creative[] }) {
```

Remove the now-unused `getCreatives` import and the `Campaign` type import if nothing else
in this file uses it (check with `grep -n "Campaign" src/components/dashboard/creatives-panel.tsx`
after this edit — `Creative` itself is still used throughout this file and must stay
imported).

- [ ] **Step 2: Fix mock.ts's Campaign/Creative fixtures for the corrected types**

Read `src/data/mock.ts`'s `getCampaigns`/`getCreatives` functions and their backing fixture
arrays. Remove `reach`/`thumbnail`/`thumbnailColor`/`startDate` from every mock `Campaign`
object, and rename `thumbnailColor` → `thumbnailUrl` on every mock `Creative` object (set it
to `null` — mock fixtures don't need a fake CDN URL, and this exercises the same
null-handling path the real data will hit for non-video/incomplete creatives). This file is
large; use `npx tsc --noEmit -p tsconfig.app.json` after editing to confirm every field
reference compiles, rather than manually cross-checking each mock object by eye.

Note: after Task 9 rewires `meta-ads.tsx` away from `mock.ts`'s `getCampaigns`/
`getCampaignActivity`/`getCreatives`, these three mock functions become dead code (nothing
in `src/` calls them anymore) — but do NOT delete them in this task. Confirm they're
genuinely unused only after Task 9 lands (`grep -rn "getCampaigns\|getCampaignActivity\|getCreatives" src/`),
and delete them then, in Task 9, not here — deleting now would be premature (Task 9 hasn't
landed yet in the task order, so nothing has proven they're unused).

- [ ] **Step 3: Run tsc**

```bash
cd /tmp/d2c-live && npx tsc --noEmit -p tsconfig.app.json
```

Expected: the `mock.ts`/`creatives-panel.tsx` errors from Task 7's Step 2 are gone. Errors
in `meta-ads.tsx` remain — Task 9 fixes those.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/creatives-panel.tsx src/data/mock.ts
git commit -m "fix: CreativesGrid takes creatives as a prop; fix mock fixtures for corrected types"
```

---

### Task 9: Rewire meta-ads.tsx to real data; delete dead mock functions

**Files:**
- Modify: `src/pages/meta-ads.tsx`
- Modify: `src/data/mock.ts` (delete now-dead functions, per Task 8's note)

**Interfaces:**
- Consumes: `useClientResource` (existing), `GET /api/clients/:id/campaigns?platform=meta`,
  `GET .../campaigns/:id/creatives`, `GET`/`POST .../campaigns/:id/notes` (Task 6).
- Produces: nothing new — leaf consumer.

- [ ] **Step 1: Replace the data-fetching and note-posting logic**

Replace:

```typescript
import { useApp } from "@/store/app-context";
import { getCampaigns, getCampaignActivity, relativeTime } from "@/data/mock";
import { formatCompact, formatCurrency, formatCurrencyCompact, formatNumber, cn } from "@/lib/utils";
import type { CampaignActivity } from "@/data/types";
```

with:

```typescript
import { useApp } from "@/store/app-context";
import { useClientResource } from "@/hooks/use-client-resource";
import { supabase } from "@/lib/supabase";
import { relativeTime } from "@/data/mock";
import { formatCompact, formatCurrency, formatCurrencyCompact, formatNumber, cn } from "@/lib/utils";
import type { Campaign, CampaignActivity, Creative } from "@/data/types";
```

(`relativeTime` is a pure formatting helper with no data dependency — stays imported from
`mock.ts`, it isn't itself mock data. `Campaign`/`Creative` need explicit type imports now
that they're not inferred from `getCampaigns`'s return type.)

Add hoisted fallback constants near the top of the file (same convention as every other
rewired page in this codebase):

```typescript
const EMPTY_CAMPAIGNS: Campaign[] = [];
const EMPTY_CREATIVES: Creative[] = [];
const EMPTY_NOTES: CampaignActivity[] = [];
```

Replace the component body's data section:

```typescript
export default function MetaAds() {
  const { client, isAllClients } = useApp();
  const { data: campaigns } = useClientResource<Campaign[]>(
    !isAllClients && client ? `/api/clients/${client.id}/campaigns?platform=meta` : null,
    EMPTY_CAMPAIGNS,
  );
  const [selectedId, setSelectedId] = React.useState(campaigns[0]?.id);
  const selected = campaigns.find((c) => c.id === selectedId) ?? campaigns[0];

  const { data: creatives } = useClientResource<Creative[]>(
    !isAllClients && client && selected ? `/api/clients/${client.id}/campaigns/${selected.id}/creatives` : null,
    EMPTY_CREATIVES,
  );
  const { data: notes, loading: notesLoading } = useClientResource<CampaignActivity[]>(
    !isAllClients && client && selected ? `/api/clients/${client.id}/campaigns/${selected.id}/notes` : null,
    EMPTY_NOTES,
  );

  const [draft, setDraft] = React.useState("");
  const [posting, setPosting] = React.useState(false);
  const [localNotes, setLocalNotes] = React.useState<CampaignActivity[]>([]);
  const activity = [...notes, ...localNotes.filter((n) => n.campaignId === selected?.id)];

  const sendNote = async () => {
    if (!draft.trim() || !selected || !client) return;
    setPosting(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setPosting(false);
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${client.id}/campaigns/${selected.id}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      if (res.ok) {
        const created = await res.json();
        setLocalNotes((prev) => [...prev, created]);
        setDraft("");
      }
    } finally {
      setPosting(false);
    }
  };
```

This drops the OLD version's purely-local, never-persisted note behavior (a note typed in
and sent would vanish on refresh, since nothing wrote it anywhere) in favor of a real POST —
`localNotes` now exists ONLY to optimistically show a just-sent note before the next natural
refetch, not as the note's only storage. Note `notesLoading` is destructured but intentionally
unused in this snippet beyond being available — wire a loading indicator into the Activity
tab if useful, following the same `{loading && <p>Loading…</p>}` pattern `ConnectionsPanel`
already established, but this isn't required for the task to be complete.

Update the send button's disabled condition and the `sendNote` call site (it's now async):

```typescript
                      <Button size="icon" onClick={sendNote} disabled={!draft.trim() || posting}>
                        <Send className="size-4" />
                      </Button>
```

- [ ] **Step 2: Remove every reference to the dropped Campaign fields**

`grep -n "\.reach\b\|\.thumbnail\b\|thumbnailColor\|startDate" src/pages/meta-ads.tsx` and
fix each:

- The campaign-list card's `<div className={cn("size-14 shrink-0 rounded-lg", c.thumbnail)} />`
  and the detail header's equivalent `selected.thumbnail` — delete both `<div>` elements
  entirely (no fallback color block; the campaign name and status badge carry the row on
  their own, matching how the Sales page's order rows have no per-row visual swatch either).
- The `totals` reducer's `acc.reach += c.reach` line — delete it, and remove the `reach`
  KPI card (`<KpiCard label="Reach" ... />`) from the top KPI row entirely, along with the
  `Users2` icon import if nothing else in this file uses it.
- `Started {new Date(selected.startDate).toLocaleDateString(...)}` in the detail header's
  `CardDescription` — delete this whole sentence fragment (keep `· {selected.resultType}`),
  since there's no real start-date data.

- [ ] **Step 3: Fix CreativesGrid's call site**

Replace:

```typescript
<CreativesGrid campaign={selected} />
```

with:

```typescript
<CreativesGrid creatives={creatives} />
```

- [ ] **Step 4: Delete the now-dead mock functions**

Confirm nothing else references them:

```bash
grep -rn "getCampaigns\|getCampaignActivity\|getCreatives" src/
```

Expected: zero matches after this task's edits above (only their own definitions in
`mock.ts`, about to be deleted). Delete `getCampaigns`, `getCampaignActivity`, and
`getCreatives` (and any fixture arrays ONLY those three functions used — check with the
same grep pattern against the fixture array names before deleting them too, since some
fixture data might still back other still-mock pages like Google Ads, which this plan
doesn't touch).

- [ ] **Step 5: Verify manually in the browser**

Start both servers, log in, connect a client's Meta account (Task 10 builds this UI — if
that task hasn't landed yet, insert a `platform_connections` row directly via SQL and run
`metaConnector.sync()` once by hand to seed real data), then visit Meta Ads and confirm it
renders real synced data with no console errors, for both a client with synced campaigns
and one with none.

- [ ] **Step 6: Run tsc and build**

```bash
cd /tmp/d2c-live && npx tsc --noEmit -p tsconfig.app.json && npm run build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/meta-ads.tsx src/data/mock.ts
git commit -m "feat: wire Meta Ads page to real campaigns, creatives, and notes"
```

---

### Task 10: Connect Meta Ads UI

**Files:**
- Modify: `src/pages/manage-clients.tsx`

**Interfaces:**
- Consumes: `useClientResource` (existing), `POST /api/clients/:id/connections/meta/authorize`
  (Task 3's registry entry + the Shopify plan's already-generic authorize route — no
  backend changes needed here at all).
- Produces: nothing new — final leaf consumer of the Meta OAuth flow.

- [ ] **Step 1: Generalize ConnectionsPanel for a second platform**

`ConnectionsPanel` today special-cases Shopify (a shop-domain input alongside its Connect
button). Meta's connect has no per-connection input at all — just a button. Read the
current `ConnectionsPanel` function in full first (it has grown across the Shopify plan's
Task 15 and two follow-up fixes — error state, `EMPTY_CONNECTIONS` fallback, etc.) before
editing, so this task's changes compose with what's already there rather than reverting it.

Add a small platform-agnostic connect button for Meta, rendered alongside (not replacing)
the existing Shopify-specific block:

```tsx
function MetaConnectButton({ clientId, connections }: { clientId: string; connections: Connection[] }) {
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const meta = connections.find((c) => c.platform === "meta");

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setConnecting(false);
      setError("You're not signed in. Please log in again.");
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${clientId}/connections/meta/authorize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to connect Meta Ads. Please try again.");
        setConnecting(false);
        return;
      }
      const { authorizeUrl } = await res.json();
      window.location.href = authorizeUrl;
    } catch {
      setError("Failed to connect Meta Ads. Please check your connection and try again.");
      setConnecting(false);
    }
  };

  if (meta && meta.status === "connected") {
    return (
      <span className="flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-[11px] font-medium text-text-secondary">
        <Megaphone className="size-3.5" />
        Meta Ads — {meta.externalAccountId}
      </span>
    );
  }

  return (
    <div>
      <Button size="sm" variant="secondary" onClick={handleConnect} disabled={connecting}>
        Connect Meta Ads
      </Button>
      {error && <p className="mt-1 text-[11px] text-negative">{error}</p>}
    </div>
  );
}
```

`Megaphone` is already imported at the top of this file (used by `INTEGRATION_ICON`).

- [ ] **Step 2: Render it inside ConnectionsPanel, alongside Shopify's block**

Find where `ConnectionsPanel` renders the Shopify connect UI/status (the
`if (shopify && shopify.status === "connected")` branch and the input+button return
below it). Wrap the WHOLE existing Shopify-specific return content in a `<div className="space-y-2">`
alongside a new `<MetaConnectButton clientId={clientId} connections={connections} />`, so
both platforms' status/connect UI show side by side in the same panel:

```tsx
  return (
    <div className="space-y-2">
      {/* ... existing shopify status-or-connect-form JSX, unchanged ... */}
      <MetaConnectButton clientId={clientId} connections={connections} />
    </div>
  );
```

Do this for BOTH of `ConnectionsPanel`'s existing return branches (the "shopify connected"
branch and the "not connected, show input" branch) — Meta's connect button must show
regardless of Shopify's own connection state, since a client can have Shopify connected but
not Meta, or vice versa, independently.

- [ ] **Step 3: Verify manually in the browser**

Log in, open a client's detail dialog, confirm both a Shopify status/connect row AND a
"Connect Meta Ads" button/status row show simultaneously, and that clicking "Connect Meta
Ads" redirects to Facebook's real login dialog (approve it there manually — this is the
plan's required manual e2e checkpoint for Meta, matching Shopify's own Task 15 pattern).

- [ ] **Step 4: Run tsc and build**

```bash
cd /tmp/d2c-live && npx tsc --noEmit -p tsconfig.app.json && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/manage-clients.tsx
git commit -m "feat: add Connect Meta Ads UI alongside Shopify's connect panel"
```

---

## What comes after this plan

The Google Ads plan (per `docs/superpowers/specs/2026-09-02-platform-integrations-design.md`)
adds its own connector to `server/src/lib/connector-registry.ts` and its own account-limit
check against `included_google_accounts` — the registry pattern, dispatch routes, state
signing, `campaigns`/`campaign_creatives`/`campaign_notes` tables, and the
`GET/POST /api/clients/:id/campaigns` routes built here (already parametrized on
`?platform=`) are not touched again, just extended. It additionally wires the Google Ads
page the same way Task 9 wired Meta Ads here, and needs its own `MetaConnectButton`-style
(renamed) button added to `ConnectionsPanel` alongside Shopify's and Meta's.
