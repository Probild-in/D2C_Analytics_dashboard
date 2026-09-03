# Google Ads Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/pages/google-ads.tsx`'s mock campaign/creative/activity data with a real Google Ads connector — OAuth connect (with genuine token refresh, unlike Meta), scheduled sync of campaigns/insights/ads, and real campaign notes — reusing the shared architecture the Shopify and Meta plans already built (connector registry, generic `/authorize`/`/callback` dispatch routes, signed state, encrypted token storage, the `campaigns`/`campaign_creatives`/`campaign_notes` tables, and the `GET/POST /api/clients/:id/campaigns*` routes, which already parametrize on `?platform=`).

**Architecture:** A `google` `Connector` implementation added to the existing `connectors` registry. Joins to the foundation's existing `google_campaign_metrics` table (kept in its current shape). Account-limit enforcement against `included_google_accounts + extra_google_accounts`, same pattern as Meta's. Sync pulls campaigns, daily metrics, and ads (as creatives) from the Google Ads API via GAQL queries over its REST interface; scheduled every 6 hours alongside Meta's, reusing the existing generic `runScheduledSyncs(platform)`.

**Key difference from the Meta plan:** Google Ads OAuth genuinely issues a `refresh_token` and short-lived (~1 hour) access tokens — unlike Meta, which (as the Meta plan's Global Constraints documented) has no refresh-token grant at all. This plan implements the real lazy-refresh-on-401 pattern the original design spec called for, which the Meta plan correctly could NOT implement because Meta doesn't support it.

**Tech Stack:** Same as the Shopify/Meta plans — Express/TypeScript backend, Postgres via `pg`, React/TypeScript frontend, `useClientResource`, `vitest`/`supertest` with `vi.stubGlobal("fetch", ...)` fixtures (no live Google API calls in tests).

**Spec:** `docs/superpowers/specs/2026-09-02-platform-integrations-design.md` — this plan implements that spec's Google Ads section. `docs/superpowers/plans/2026-09-03-meta-ads-integration.md` built the shared `campaigns`/`campaign_creatives`/`campaign_notes` tables and the generic read/write routes this plan reuses without modification (aside from one bug fix — see Task 1).

## Global Constraints

- Standard `{error:{code,message}}` shape for every error response.
- Access AND refresh tokens encrypted via `server/src/lib/crypto.ts` before storage.
- OAuth callback failures redirect with an error query param and never leave a half-created `platform_connections` row.
- Account-limit enforcement happens inside `handleCallback`, BEFORE the connection upsert, against `included_google_accounts + extra_google_accounts` — same pattern as Meta's `assertUnderMetaAccountLimit`, just a different column pair.
- No live Google API calls in any test file — `vi.stubGlobal("fetch", ...)` fixtures only.
- `google_campaign_metrics` keeps its existing column shape. Its results-equivalent column is named `conversions`, NOT `results` (unlike `meta_campaign_metrics`, which uses `results`) — Task 1 fixes a real bug in the existing shared `campaigns.ts` route that assumed both tables use the same column name and would throw "column does not exist" for `platform=google` as currently written.
- Google Ads reports cost as `cost_micros` (an integer where 1,000,000 micros = 1 currency unit) — every cost value from the API must be divided by 1,000,000 and rounded before storage, matching this codebase's existing convention of storing money as whole-unit integers (paise/cents are never used; `Math.round()` after the micros division, same rounding convention as Shopify's `Math.round(parseFloat(order.total_price))`).
- Responsive Search Ads (Google's dominant ad format) have MULTIPLE headlines and MULTIPLE descriptions per ad (Google auto-tests combinations) — not one of each, unlike Meta's single-headline creative model. This plan uses the FIRST headline and FIRST description as the `campaign_creatives.headline`/`primary_text` values, a deliberate simplification (documented here, not silently done) rather than inventing a "combinations" concept the shared table was never designed to hold. A future pass could add a `headline_variants`/`description_variants` jsonb column if this dashboard ever needs to show ad testing detail — out of scope here.
- Search ads have no visual creative asset at all (`thumbnail_url` stays `null` for them) — this dashboard's `CreativesGrid` component already renders a demo-image/icon fallback for a `null` thumbnail (built in the Meta plan's Task 8), so this needs no frontend change.
- `login-customer-id` resolution is simplified to "use the first ad account `listAccessibleCustomers` returns, as both the connection's `external_account_id` and its own `login-customer-id`" — this does NOT handle the full manager-account (MCC) hierarchy-traversal Google's own docs describe for agencies managing many sub-accounts under one MCC. That's real, out-of-scope complexity for a first pass (the account-limit enforcement in this plan already assumes one Google connection per client maps to one directly-connected ad account, not an MCC fan-out) — track as a follow-up if the agency's actual Google account structure turns out to be MCC-based.
- Manual end-to-end verification against a real Google Ads developer account and a live Google Cloud OAuth client is required before considering this plan done — this can't be automated, same bar every prior plan in this rollout held itself to.

## File Structure

- Create: `server/src/integrations/google.ts` — the `google` connector.
- Modify: `server/src/integrations/types.ts` — no change needed (Task 2 of the Meta plan already generalized `handleCallback`'s signature to accept `context: {clientId}`, which this connector uses identically).
- Modify: `server/src/lib/connector-registry.ts` — register `google`.
- Modify: `server/src/scheduler.ts` — add Google to the existing 6-hourly cron (same schedule as Meta, different `runScheduledSyncs` call).
- Modify: `server/src/routes/campaigns.ts` — fix the `results`/`conversions` column-name bug (Task 1, done first since it blocks Task 6's tests from passing honestly).
- Modify: `server/.env.example` — document `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`.
- Modify: `src/pages/google-ads.tsx` — rewire from `mock.ts`'s `getCampaigns`/`getCampaignActivity`/`getCreatives` to `useClientResource`, same pattern as the Meta plan's Task 9 (mock.ts's functions stay — `blended-marketing.tsx` still depends on them for Meta's mock data, unaffected by this plan).
- Modify: `src/pages/manage-clients.tsx` — add a `GoogleConnectButton` alongside `MetaConnectButton`.

---

### Task 1: Fix campaigns.ts's results/conversions column-name and resultType bugs

**Files:**
- Modify: `server/src/routes/campaigns.ts`
- Test: `server/test/routes/campaigns.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/clients/:id/campaigns?platform=google` now actually works and shows
  the right result-metric label — every other task in this plan depends on this being
  fixed first, since Task 7's page would otherwise show real Google campaigns labeled
  "Purchases" (copied verbatim from Meta, hardcoded regardless of platform) instead of the
  generic "Conversions" label Google's actual conversion tracking deserves (matching what
  the original mock data already correctly distinguished: `resultType: platform === "meta"
  ? "Purchases" : "Conversions"` in `src/data/mock.ts`'s `getCampaigns`, before this route
  replaced it — this route just never carried that distinction over).

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/campaigns.test.ts`, inside (or alongside) the existing
`describe("GET /api/clients/:id/campaigns", ...)` block — read that block's existing
`beforeEach` fixture first; it seeds a `meta` connection/campaign, so this new test needs
its own `google`-platform fixture data:

```typescript
  it("returns campaigns for platform=google using the conversions column, not results", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('88888888-8888-8888-8888-888888888888', 'abc-fashion', 'google', 'connected', '1234567890')`,
    );
    await testPool.query(
      `insert into campaigns (id, client_id, connection_id, external_campaign_id, name, status) values
       ('99999999-9999-9999-9999-999999999999', 'abc-fashion', '88888888-8888-8888-8888-888888888888', 'camp_g1', 'Search - Brand Terms', 'active')`,
    );
    await testPool.query(
      `insert into google_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, conversions) values
       ('abc-fashion', '88888888-8888-8888-8888-888888888888', 'camp_g1', 'Search - Brand Terms', current_date, 400, 8000, 200, 15)`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns?platform=google")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "99999999-9999-9999-9999-999999999999",
      name: "Search - Brand Terms",
      spend: 400,
      results: 15,
      resultType: "Conversions",
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- campaigns.test.ts
```

Expected: FAIL — Postgres error, `column m.results does not exist` (the query currently
hardcodes `m.results` regardless of platform, but `google_campaign_metrics` only has
`conversions`). Once that's fixed you'd hit a second failure on `resultType` still being
`"Purchases"` — both are fixed together in Step 3.

- [ ] **Step 3: Fix the query and the resultType label**

In `server/src/routes/campaigns.ts`'s `GET /` handler, find:

```typescript
    const platform = req.query.platform === "google" ? "google" : "meta";
    const metricsTable = platform === "google" ? "google_campaign_metrics" : "meta_campaign_metrics";
```

Add a third line right after it:

```typescript
    const resultsColumn = platform === "google" ? "conversions" : "results";
```

Then find the SQL query's `left join`/`sum` block:

```typescript
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
```

Replace `coalesce(sum(m.results), 0)::int as results` with
`coalesce(sum(m.${resultsColumn}), 0)::int as results` (a template-literal column
reference, same pattern already used for `${metricsTable}` two lines above it — this is
not raw user input, `resultsColumn` is constrained to one of two hardcoded literals by the
ternary above, identical in shape to the Shopify plan's own `${level}` interpolation that
was reviewed and confirmed safe for the same reason).

Then find, in the response-mapping block just below:

```typescript
        results: r.results,
        resultType: "Purchases",
```

Replace with:

```typescript
        results: r.results,
        resultType: platform === "google" ? "Conversions" : "Purchases",
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- campaigns.test.ts
```

Expected: PASS — all tests in this file, including the pre-existing Meta-platform ones
(confirm the fix didn't change Meta's behavior, since `resultsColumn` evaluates to
`"results"` for the meta path, identical to before).

- [ ] **Step 5: Run the full suite**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/campaigns.ts server/test/routes/campaigns.test.ts
git commit -m "fix(server): campaigns route used the wrong metrics column name for platform=google"
```

---

### Task 2: Google connector — getAuthUrl, handleCallback, account-limit enforcement

**Files:**
- Create: `server/src/integrations/google.ts`
- Test: `server/test/integrations/google.test.ts`

**Interfaces:**
- Consumes: `Connector` interface (unchanged since the Meta plan's Task 2 already
  generalized it), `encryptToken`/`decryptToken`.
- Produces: `googleConnector: Connector`. Task 3 registers it; Task 5 calls
  `googleConnector.sync`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/integrations/google.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { googleConnector } from "../../src/integrations/google.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

beforeEach(() => {
  process.env.GOOGLE_ADS_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "test-developer-token";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleConnector.getAuthUrl", () => {
  it("builds a Google OAuth consent URL requesting offline access and the adwords scope", () => {
    const url = googleConnector.getAuthUrl("abc-fashion", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/google/callback");
  });
});

describe("googleConnector.handleCallback", () => {
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
      `insert into subscriptions (client_id, plan_id, status, extra_google_accounts) values
       ('abc-fashion', 'starter', 'active', 0)`,
    );
  });

  it("exchanges the code for tokens and resolves the accessible customer id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "ya29.real-token", refresh_token: "1//real-refresh-token", expires_in: 3599 }), { status: 200 });
        }
        if (url.includes("listAccessibleCustomers")) {
          return new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const result = await googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" });
    expect(result.externalAccountId).toBe("1234567890");
    expect(result.accessToken).toBe("ya29.real-token");
    expect(result.refreshToken).toBe("1//real-refresh-token");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid_grant", { status: 400 })));
    await expect(googleConnector.handleCallback({ code: "bad-code" }, { clientId: "abc-fashion" })).rejects.toThrow();
  });

  it("throws if no refresh_token is returned (user previously granted consent without prompt=consent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "ya29.real-token", expires_in: 3599 }), { status: 200 })),
    );
    await expect(googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/refresh token/i);
  });

  it("throws if no accessible customer is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "ya29.real-token", refresh_token: "1//real-refresh-token", expires_in: 3599 }), { status: 200 });
        }
        return new Response(JSON.stringify({ resourceNames: [] }), { status: 200 });
      }),
    );
    await expect(googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/customer/i);
  });

  it("throws when the client is already at its Google account limit", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, access_token, external_account_id) values
       ('abc-fashion', 'google', 'connected', 'x', '9999999999')`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "ya29.real-token", refresh_token: "1//real-refresh-token", expires_in: 3599 }), { status: 200 });
        }
        return new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), { status: 200 });
      }),
    );
    await expect(googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/limit/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- google.test.ts
```

Expected: FAIL — `server/src/integrations/google.ts` doesn't exist yet.

- [ ] **Step 3: Write the connector**

```typescript
// server/src/integrations/google.ts
import type { Connector } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";

const GOOGLE_ADS_API_VERSION = "v25";
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/adwords";

function getRedirectUri(): string {
  const publicApiUrl = process.env.PUBLIC_API_URL;
  if (!publicApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${publicApiUrl}/api/integrations/google/callback`;
}

function getOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET environment variables must be set");
  }
  return { clientId, clientSecret };
}

function getDeveloperToken(): string {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN environment variable must be set");
  }
  return token;
}

async function assertUnderGoogleAccountLimit(clientId: string): Promise<void> {
  const result = await pool.query(
    `select
       coalesce(p.included_google_accounts, 0) + coalesce(s.extra_google_accounts, 0) as limit,
       (select count(*) from platform_connections where client_id = $1 and platform = 'google' and status = 'connected') as current_count
     from subscriptions s
     join plans p on p.id = s.plan_id
     where s.client_id = $1`,
    [clientId],
  );
  if (result.rowCount === 0) {
    throw new Error("This client has no active subscription — cannot connect a Google account");
  }
  const { limit, current_count: currentCount } = result.rows[0];
  if (Number(currentCount) >= Number(limit)) {
    throw new Error(`Google account limit reached (${limit} account(s) included on this client's plan)`);
  }
}

export const googleConnector: Connector = {
  platform: "google",

  getAuthUrl(_clientId: string, state: string): string {
    const { clientId } = getOAuthCredentials();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
    // access_type=offline + prompt=consent together are required to get a refresh_token
    // back — Google only issues one on a user's FIRST consent unless prompt=consent
    // forces the consent screen (and a fresh refresh_token) every time. Without both,
    // a user who previously authorized this app for an unrelated reason would silently
    // get no refresh_token at all, and this connector has no way to function without one.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>, context: { clientId: string }) {
    const code = query.code;
    if (!code) {
      throw new Error("Google callback missing code query parameter");
    }
    await assertUnderGoogleAccountLimit(context.clientId);

    const { clientId, clientSecret } = getOAuthCredentials();
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getRedirectUri(),
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed: ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    if (!tokenBody.refresh_token) {
      throw new Error("Google did not return a refresh token — try disconnecting this app's access at myaccount.google.com/permissions and reconnecting");
    }

    const customersRes = await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "developer-token": getDeveloperToken(),
      },
    });
    if (!customersRes.ok) {
      throw new Error(`Google listAccessibleCustomers failed: ${customersRes.status}`);
    }
    const customersBody = (await customersRes.json()) as { resourceNames: string[] };
    if (customersBody.resourceNames.length === 0) {
      throw new Error("No Google Ads customer account is accessible with this login");
    }
    // "customers/1234567890" -> "1234567890". Simplified to the first accessible
    // customer for both the connection's external_account_id and its own
    // login-customer-id — see this plan's Global Constraints for why full MCC
    // hierarchy traversal is deliberately out of scope here.
    const externalAccountId = customersBody.resourceNames[0].split("/")[1];

    return {
      externalAccountId,
      accessToken: tokenBody.access_token,
      refreshToken: tokenBody.refresh_token,
      expiresAt: tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000) : undefined,
    };
  },

  async sync(_connectionId: string) {
    // Implemented in Task 5.
    return { recordsSynced: 0 };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- google.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full suite and tsc**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/google.ts server/test/integrations/google.test.ts
git commit -m "feat(server): add Google connector OAuth (getAuthUrl, handleCallback, account-limit enforcement)"
```

---

### Task 3: Register the Google connector; add env vars

**Files:**
- Modify: `server/src/lib/connector-registry.ts`
- Modify: `server/.env.example`
- Test: `server/test/routes/connections.test.ts` (append)

**Interfaces:**
- Consumes: `googleConnector` (Task 2).
- Produces: `connectors.google`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/connections.test.ts`, inside the existing
`describe("POST /api/clients/:id/connections/:platform/authorize", ...)` block:

```typescript
  it("resolves the google connector and returns an authorizeUrl", async () => {
    process.env.GOOGLE_ADS_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.GOOGLE_ADS_CLIENT_SECRET = "test-client-secret";
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/google/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("accounts.google.com");
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- connections.test.ts
```

Expected: FAIL — 404 `unknown_platform`.

- [ ] **Step 3: Register the connector**

```typescript
// server/src/lib/connector-registry.ts
import type { Connector } from "../integrations/types.js";
import { shopifyConnector } from "../integrations/shopify.js";
import { metaConnector } from "../integrations/meta.js";
import { googleConnector } from "../integrations/google.js";

export const connectors: Record<string, Connector> = {
  shopify: shopifyConnector,
  meta: metaConnector,
  google: googleConnector,
};
```

- [ ] **Step 4: Document the new env vars**

Append to `server/.env.example`:

```bash
# Google Ads API credentials. GOOGLE_ADS_CLIENT_ID/SECRET come from a Google Cloud OAuth
# 2.0 Client ID (Web application type). GOOGLE_ADS_DEVELOPER_TOKEN comes from a Google Ads
# manager account's API Center (requires basic/standard access approval from Google, a
# separate process from the OAuth client itself).
GOOGLE_ADS_CLIENT_ID=replace-with-your-oauth-client-id.apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=replace-with-your-oauth-client-secret
GOOGLE_ADS_DEVELOPER_TOKEN=replace-with-your-developer-token
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- connections.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/connector-registry.ts server/.env.example server/test/routes/connections.test.ts
git commit -m "feat(server): register google connector, document Google Ads env vars"
```

---

### Task 4: Real token refresh on 401

**Files:**
- Modify: `server/src/integrations/google.ts`
- Test: `server/test/integrations/google.test.ts` (append)

**Interfaces:**
- Consumes: `platform_connections.refresh_token` (already encrypted at rest, decrypted
  here the same way `access_token` is).
- Produces: an internal `getValidAccessToken(connectionId)` helper Task 5's `sync()` calls
  instead of reading `access_token` directly — this is the one piece of real machinery
  this plan adds that the Meta plan structurally could not (no refresh_token exists there).

- [ ] **Step 1: Write the failing test**

Append to `server/test/integrations/google.test.ts`:

```typescript
describe("googleConnector token refresh", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  });

  it("refreshes an expired access token once and retries the request that triggered it", async () => {
    const { encryptToken } = await import("../../src/lib/crypto.js");
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, refresh_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'google', 'connected', $1, $2, '1234567890')`,
      [encryptToken("stale-access-token"), encryptToken("1//real-refresh-token")],
    );

    let campaignsCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fresh-access-token", expires_in: 3599 }), { status: 200 });
        }
        if (url.includes("searchStream")) {
          campaignsCallCount++;
          const authHeader = (init?.headers as Record<string, string>)?.Authorization;
          if (authHeader === "Bearer stale-access-token") {
            return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), { status: 401 });
          }
          return new Response(JSON.stringify([{ results: [] }]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await googleConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(0);
    expect(campaignsCallCount).toBe(2); // first call 401s, second (post-refresh) succeeds

    const conn = await testPool.query("select access_token from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    const { decryptToken } = await import("../../src/lib/crypto.js");
    expect(decryptToken(conn.rows[0].access_token)).toBe("fresh-access-token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- google.test.ts
```

Expected: FAIL — `sync()` is still the Task 2 stub, and doesn't fetch anything.

- [ ] **Step 3: Add the refresh helper**

Add to `server/src/integrations/google.ts`:

```typescript
import { encryptToken } from "../lib/crypto.js";

async function refreshAccessToken(connectionId: string, refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getOAuthCredentials();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  await pool.query(
    "update platform_connections set access_token = $2, token_expires_at = $3 where id = $1",
    [connectionId, encryptToken(body.access_token), body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null],
  );
  return body.access_token;
}

// Wraps a single Google Ads API call with lazy refresh-on-401: tries the request with the
// current access token; if Google returns 401 (the token expired — these are short-lived,
// ~1 hour), refreshes once via the stored refresh_token and retries exactly once more. A
// 401 after the retry means the refresh_token itself is no longer valid (e.g. revoked) and
// is allowed to propagate as a real failure, same as any other sync error.
async function withTokenRefresh<T>(
  connectionId: string,
  accessToken: string,
  refreshToken: string,
  makeRequest: (token: string) => Promise<Response>,
  parseResponse: (res: Response) => Promise<T>,
): Promise<T> {
  let res = await makeRequest(accessToken);
  if (res.status === 401) {
    const freshToken = await refreshAccessToken(connectionId, refreshToken);
    res = await makeRequest(freshToken);
  }
  if (!res.ok) {
    throw new Error(`Google Ads API request failed: ${res.status}`);
  }
  return parseResponse(res);
}
```

- [ ] **Step 4: Wire a minimal sync() that uses it (fully implemented in Task 5)**

Replace the Task 2 stub:

```typescript
  async sync(_connectionId: string) {
    // Implemented in Task 5.
    return { recordsSynced: 0 };
  },
```

with:

```typescript
  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, refresh_token, external_account_id from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);
    const refreshToken = decryptToken(conn.refresh_token);
    const customerId = conn.external_account_id;

    const campaignsQuery = "SELECT campaign.id, campaign.name, campaign.status FROM campaign";
    await withTokenRefresh(
      connectionId,
      accessToken,
      refreshToken,
      (token) =>
        fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "developer-token": getDeveloperToken(),
            "login-customer-id": customerId,
          },
          body: JSON.stringify({ query: campaignsQuery }),
        }),
      (res) => res.json(),
    );

    // Full campaign/metrics/ad upsert logic added in Task 5.
    return { recordsSynced: 0 };
  },
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- google.test.ts
```

Expected: PASS — the new refresh test passes; the `handleCallback` tests from Task 2 are
unaffected.

- [ ] **Step 6: Run the full suite and tsc**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add server/src/integrations/google.ts server/test/integrations/google.test.ts
git commit -m "feat(server): add lazy refresh-on-401 for Google's short-lived access tokens"
```

---

### Task 5: Full sync — campaigns, daily metrics, ads as creatives

**Files:**
- Modify: `server/src/integrations/google.ts`
- Test: `server/test/integrations/google.test.ts` (append)

**Interfaces:**
- Consumes: `campaigns`/`campaign_creatives`/`google_campaign_metrics` tables,
  `withTokenRefresh` (Task 4).
- Produces: real `googleConnector.sync()` — Task 6's scheduler and the existing generic
  `POST /:platform/sync` route both call this unchanged.

- [ ] **Step 1: Write the failing test**

Append to `server/test/integrations/google.test.ts`:

```typescript
describe("googleConnector.sync (full)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    const { encryptToken } = await import("../../src/lib/crypto.js");
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, refresh_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'google', 'connected', $1, $2, '1234567890')`,
      [encryptToken("real-access-token"), encryptToken("1//real-refresh-token")],
    );
  });

  it("upserts campaigns, daily metrics, and ads as creatives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.includes("searchStream")) throw new Error(`Unexpected fetch: ${url}`);
        const body = JSON.parse((init?.body as string) ?? "{}") as { query: string };
        if (body.query.includes("FROM campaign")) {
          return new Response(
            JSON.stringify([{ results: [{ campaign: { id: "111", name: "Search - Brand Terms", status: "ENABLED" } }] }]),
            { status: 200 },
          );
        }
        if (body.query.includes("metrics.impressions") && body.query.includes("FROM campaign")) {
          return new Response(
            JSON.stringify([
              {
                results: [
                  {
                    campaign: { id: "111", name: "Search - Brand Terms" },
                    metrics: { impressions: "8000", clicks: "200", costMicros: "400000000", conversions: "15" },
                  },
                ],
              },
            ]),
            { status: 200 },
          );
        }
        if (body.query.includes("FROM ad_group_ad")) {
          return new Response(
            JSON.stringify([
              {
                results: [
                  {
                    adGroupAd: {
                      ad: {
                        id: "222",
                        name: "Brand RSA 1",
                        responsiveSearchAd: {
                          headlines: [{ text: "Shop the Sale Today" }, { text: "Free Shipping Over ₹999" }],
                          descriptions: [{ text: "Premium quality, fast delivery, easy returns." }],
                        },
                      },
                      status: "ENABLED",
                    },
                    campaign: { id: "111" },
                    metrics: { impressions: "3000", clicks: "90", costMicros: "150000000", conversions: "6" },
                  },
                ],
              },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`Unhandled query: ${body.query}`);
      }),
    );

    const result = await googleConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(1);

    const campaigns = await testPool.query("select * from campaigns where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(campaigns.rowCount).toBe(1);
    expect(campaigns.rows[0]).toMatchObject({ external_campaign_id: "111", name: "Search - Brand Terms", status: "active" });

    const metrics = await testPool.query("select * from google_campaign_metrics where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(metrics.rowCount).toBe(1);
    expect(metrics.rows[0]).toMatchObject({ campaign_id: "111", spend: 400, impressions: 8000, clicks: 200, conversions: 15 });

    const creatives = await testPool.query("select * from campaign_creatives where campaign_id = $1", [campaigns.rows[0].id]);
    expect(creatives.rowCount).toBe(1);
    expect(creatives.rows[0]).toMatchObject({
      external_creative_id: "222",
      name: "Brand RSA 1",
      format: "RESPONSIVE_SEARCH_AD",
      headline: "Shop the Sale Today",
      primary_text: "Premium quality, fast delivery, easy returns.",
      thumbnail_url: null,
      status: "active",
      spend: 150,
      impressions: 3000,
      clicks: 90,
      results: 6,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- google.test.ts
```

Expected: FAIL — Task 4's `sync()` only fetches the campaign-id/name/status query and
discards the result, never touching metrics/ads or writing anything.

- [ ] **Step 3: Implement the full sync**

Replace Task 4's minimal `sync()` body in `server/src/integrations/google.ts`:

```typescript
interface GoogleCampaignRow {
  campaign: { id: string; name: string; status: string };
}

interface GoogleMetricsRow {
  campaign: { id: string; name: string };
  metrics: { impressions: string; clicks: string; costMicros: string; conversions: string };
}

interface GoogleAdRow {
  adGroupAd: {
    ad: {
      id: string;
      name: string;
      responsiveSearchAd?: { headlines: { text: string }[]; descriptions: { text: string }[] };
    };
    status: string;
  };
  campaign: { id: string };
  metrics: { impressions: string; clicks: string; costMicros: string; conversions: string };
}

// Google's status vocabulary (ENABLED/PAUSED/REMOVED/...) maps onto this dashboard's
// narrower enum the same deliberately-lossy way Shopify's and Meta's connectors do.
function mapGoogleStatus(status: string): string {
  const s = status.toUpperCase();
  if (s === "ENABLED") return "active";
  if (s === "PAUSED") return "paused";
  return "paused";
}

function microsToUnits(micros: string): number {
  return Math.round(parseFloat(micros) / 1_000_000);
}

async function runGaqlQuery<T>(
  connectionId: string,
  accessToken: string,
  refreshToken: string,
  customerId: string,
  query: string,
): Promise<T[]> {
  const body = await withTokenRefresh(
    connectionId,
    accessToken,
    refreshToken,
    (token) =>
      fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "developer-token": getDeveloperToken(),
          "login-customer-id": customerId,
        },
        body: JSON.stringify({ query }),
      }),
    (res) => res.json(),
  );
  // searchStream returns an array of response "batches", each with its own `results` array
  // — flatten them into one list of rows, matching how this codebase treats every other
  // connector's response as a flat list to iterate.
  return (body as { results?: T[] }[]).flatMap((batch) => batch.results ?? []);
}
```

Then replace `sync()`'s body:

```typescript
  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, refresh_token, external_account_id from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);
    const refreshToken = decryptToken(conn.refresh_token);
    const customerId = conn.external_account_id;

    const campaignRows = await runGaqlQuery<GoogleCampaignRow>(
      connectionId,
      accessToken,
      refreshToken,
      customerId,
      "SELECT campaign.id, campaign.name, campaign.status FROM campaign",
    );

    let recordsSynced = 0;
    for (const row of campaignRows) {
      const campaignRow = await pool.query(
        `insert into campaigns (client_id, connection_id, external_campaign_id, name, status)
         values ($1, $2, $3, $4, $5)
         on conflict (connection_id, external_campaign_id)
         do update set name = excluded.name, status = excluded.status
         returning id`,
        [conn.client_id, connectionId, row.campaign.id, row.campaign.name, mapGoogleStatus(row.campaign.status)],
      );
      const campaignRowId = campaignRow.rows[0].id;
      recordsSynced++;

      const metricsRows = await runGaqlQuery<GoogleMetricsRow>(
        connectionId,
        accessToken,
        refreshToken,
        customerId,
        `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.id = ${row.campaign.id} AND segments.date DURING TODAY`,
      );
      for (const m of metricsRows) {
        await pool.query(
          `insert into google_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, conversions)
           values ($1, $2, $3, $4, current_date, $5, $6, $7, $8)
           on conflict (connection_id, campaign_id, metric_date)
           do update set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks, conversions = excluded.conversions`,
          [
            conn.client_id,
            connectionId,
            m.campaign.id,
            m.campaign.name,
            microsToUnits(m.metrics.costMicros),
            Math.round(parseFloat(m.metrics.impressions)),
            Math.round(parseFloat(m.metrics.clicks)),
            Math.round(parseFloat(m.metrics.conversions)),
          ],
        );
      }

      const adRows = await runGaqlQuery<GoogleAdRow>(
        connectionId,
        accessToken,
        refreshToken,
        customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status, campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE campaign.id = ${row.campaign.id} AND segments.date DURING TODAY`,
      );
      for (const adRow of adRows) {
        const rsa = adRow.adGroupAd.ad.responsiveSearchAd;
        await pool.query(
          `insert into campaign_creatives
             (campaign_id, external_creative_id, name, format, headline, primary_text, cta, thumbnail_url, status, spend, impressions, clicks, results)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (campaign_id, external_creative_id)
           do update set name = excluded.name, status = excluded.status, spend = excluded.spend,
             impressions = excluded.impressions, clicks = excluded.clicks, results = excluded.results`,
          [
            campaignRowId,
            adRow.adGroupAd.ad.id,
            adRow.adGroupAd.ad.name,
            "RESPONSIVE_SEARCH_AD",
            rsa?.headlines[0]?.text ?? null,
            rsa?.descriptions[0]?.text ?? null,
            null, // Google Search ads have no single "call to action" field the way Meta's do
            null, // no visual asset for a text-only search ad
            mapGoogleStatus(adRow.adGroupAd.status),
            microsToUnits(adRow.metrics.costMicros),
            Math.round(parseFloat(adRow.metrics.impressions)),
            Math.round(parseFloat(adRow.metrics.clicks)),
            Math.round(parseFloat(adRow.metrics.conversions)),
          ],
        );
      }
    }

    await pool.query("update platform_connections set last_synced_at = now(), status = 'connected' where id = $1", [connectionId]);
    return { recordsSynced };
  },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- google.test.ts
```

- [ ] **Step 5: Run the full suite and tsc**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/google.ts server/test/integrations/google.test.ts
git commit -m "feat(server): implement full Google connector sync (campaigns, metrics, ads as creatives)"
```

---

### Task 6: Scheduler — add Google's 6-hourly sync

**Files:**
- Modify: `server/src/scheduler.ts`
- Test: `server/test/scheduler.test.ts` (append)

**Interfaces:**
- Consumes: `runScheduledSyncs(platform: string)` (unchanged).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Update the existing `startScheduler` test in `server/test/scheduler.test.ts` (added by the
Meta plan's Task 5) to also expect a Google-tagged call. Since `cron.schedule` is called
with the SAME cron expression (`"0 */6 * * *"`) for both Meta and Google, distinguish them
by asserting the callback functions themselves trigger the right `runScheduledSyncs` call
— spy on `runScheduledSyncs` directly instead of trying to distinguish by cron string:

Replace:

```typescript
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

with:

```typescript
describe("startScheduler", () => {
  it("schedules the hourly Shopify sync and a 6-hourly sync for both Meta and Google", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("0 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    const sixHourlyCalls = scheduleSpy.mock.calls.filter((call) => call[0] === "0 */6 * * *");
    expect(sixHourlyCalls).toHaveLength(2);
    scheduleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- scheduler.test.ts
```

Expected: FAIL — only one `"0 */6 * * *"` registration exists today (Meta's).

- [ ] **Step 3: Add Google's schedule**

In `server/src/scheduler.ts`'s `startScheduler()`, add a third `cron.schedule` call after
Meta's:

```typescript
  cron.schedule(
    "0 */6 * * *",
    () => {
      runScheduledSyncs("google").catch((err) => console.error("Google scheduled sync failed:", err));
    },
    { noOverlap: true },
  );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- scheduler.test.ts
```

- [ ] **Step 5: Run the full suite**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```

- [ ] **Step 6: Commit**

```bash
git add server/src/scheduler.ts server/test/scheduler.test.ts
git commit -m "feat(server): schedule Google sync every 6 hours"
```

---

### Task 7: Rewire google-ads.tsx to real data

**Files:**
- Modify: `src/pages/google-ads.tsx`

**Interfaces:**
- Consumes: `useClientResource`, `GET /api/clients/:id/campaigns?platform=google`,
  `GET .../campaigns/:id/creatives`, `GET`/`POST .../campaigns/:id/notes` (all already
  built and platform-parametrized; Task 1 fixed the one bug blocking the google path).
- Produces: nothing new — leaf consumer.

- [ ] **Step 1: Replace the data-fetching and note-posting logic**

This page's mock-to-real rewiring is nearly identical to the Meta plan's Task 9 — same
`useClientResource` pattern, same real-POST note-sending, same hoisted `EMPTY_*`
constants. Follow that task's approach exactly, adjusted for this file:

Replace:

```typescript
import { useApp } from "@/store/app-context";
import { getCampaigns, getCampaignActivity, getCreatives, relativeTime } from "@/data/mock";
import type { Campaign, CampaignActivity } from "@/data/types";
```

with:

```typescript
import { useApp } from "@/store/app-context";
import { useClientResource } from "@/hooks/use-client-resource";
import { supabase } from "@/lib/supabase";
import { relativeTime } from "@/data/mock";
import type { Campaign, CampaignActivity, Creative } from "@/data/types";
```

Add hoisted constants near the top of the file:

```typescript
const EMPTY_CAMPAIGNS: Campaign[] = [];
const EMPTY_CREATIVES: Creative[] = [];
const EMPTY_NOTES: CampaignActivity[] = [];
```

Replace the `GoogleAds` component's data section:

```typescript
export default function GoogleAds() {
  const { client, isAllClients } = useApp();
  const { data: campaigns } = useClientResource<Campaign[]>(
    !isAllClients && client ? `/api/clients/${client.id}/campaigns?platform=google` : null,
    EMPTY_CAMPAIGNS,
  );
  const [selectedCampaign, setSelectedCampaign] = React.useState<Campaign | null>(null);
```

(`cid`/`getCampaigns(cid, "google")` are removed — same `!isAllClients && client` gating
pattern established by the Shopify plan's Task 14 and reused by the Meta plan's Task 9,
NOT the always-truthy `cid` placeholder pattern that plan found and fixed as a real bug.)

The rest of `totals` computation is unchanged (it already reads `c.spend`/`c.clicks`/
`c.impressions`/`c.results`, all present on the real `Campaign` shape).

Replace `CampaignDetailDialog`'s data section:

```typescript
function CampaignDetailDialog({ campaign, onOpenChange }: { campaign: Campaign | null; onOpenChange: (open: boolean) => void }) {
  const { client, isAllClients } = useApp();
  const { data: creatives } = useClientResource<Creative[]>(
    !isAllClients && client && campaign ? `/api/clients/${client.id}/campaigns/${campaign.id}/creatives` : null,
    EMPTY_CREATIVES,
  );
  const { data: notes } = useClientResource<CampaignActivity[]>(
    !isAllClients && client && campaign ? `/api/clients/${client.id}/campaigns/${campaign.id}/notes` : null,
    EMPTY_NOTES,
  );
  const [localNotes, setLocalNotes] = React.useState<CampaignActivity[]>([]);
  const activity = [...notes, ...localNotes.filter((n) => n.campaignId === campaign?.id)];
  const [draft, setDraft] = React.useState("");
  const [posting, setPosting] = React.useState(false);

  const sendNote = async () => {
    if (!draft.trim() || !campaign || !client) return;
    setPosting(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setPosting(false);
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${client.id}/campaigns/${campaign.id}/notes`, {
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

`CampaignDetailDialog` needs `useApp` imported too (it's a separate component in the same
file, doesn't inherit the page component's hook call) — add `import { useApp } from
"@/store/app-context";` if not already present at the top (it already is, per the existing
import list — just confirm `CampaignDetailDialog` itself calls it, since the ORIGINAL code
only called `useApp()` inside `GoogleAds`, not inside this dialog component).

Update the send button:

```typescript
                      <Button size="icon" onClick={sendNote} disabled={!draft.trim() || posting}>
                        <Send className="size-4" />
                      </Button>
```

Update the creatives tab's call site:

```typescript
                  <TabsContent value="creatives" className="mt-3">
                    <div className="scrollbar-thin max-h-[280px] overflow-y-auto pr-1">
                      <CreativesGrid creatives={creatives} />
                    </div>
                  </TabsContent>
```

- [ ] **Step 2: Verify manually in the browser**

Same manual-verification pattern as every prior task in this rollout: start both servers,
log in, connect a client's Google Ads account (Task 8 builds this UI — if not landed yet,
insert a `platform_connections` row directly via SQL and run `googleConnector.sync()` once
by hand to seed real data), then visit Google Ads and confirm it renders real data with no
console errors, for both a client with synced campaigns and one with none.

- [ ] **Step 3: Run tsc and build**

```bash
cd /tmp/d2c-live && npx tsc --noEmit -p tsconfig.app.json && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/google-ads.tsx
git commit -m "feat: wire Google Ads page to real campaigns, creatives, and notes"
```

---

### Task 8: Connect Google Ads UI

**Files:**
- Modify: `src/pages/manage-clients.tsx`

**Interfaces:**
- Consumes: `POST /api/clients/:id/connections/google/authorize` (Task 3's registry entry
  + the already-generic authorize route — no backend changes needed).
- Produces: nothing new — final leaf consumer of the Google OAuth flow.

- [ ] **Step 1: Add a GoogleConnectButton, mirroring MetaConnectButton exactly**

Add near `MetaConnectButton` (same file):

```tsx
function GoogleConnectButton({ clientId, connections }: { clientId: string; connections: Connection[] }) {
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const google = connections.find((c) => c.platform === "google");

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
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${clientId}/connections/google/authorize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to connect Google Ads. Please try again.");
        setConnecting(false);
        return;
      }
      const { authorizeUrl } = await res.json();
      window.location.href = authorizeUrl;
    } catch {
      setError("Failed to connect Google Ads. Please check your connection and try again.");
      setConnecting(false);
    }
  };

  if (google && google.status === "connected") {
    return (
      <span className="flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-[11px] font-medium text-text-secondary">
        <SearchIcon className="size-3.5" />
        Google Ads — {google.externalAccountId}
      </span>
    );
  }

  return (
    <div>
      <Button size="sm" variant="secondary" onClick={handleConnect} disabled={connecting}>
        Connect Google Ads
      </Button>
      {error && <p className="mt-1 text-[11px] text-negative">{error}</p>}
    </div>
  );
}
```

`SearchIcon` is already imported in this file (aliased from lucide-react's `Search`, used
by `INTEGRATION_ICON`'s `google` entry — confirm the exact import alias with
`grep -n "Search as SearchIcon" src/pages/manage-clients.tsx` before using it verbatim; if
the alias differs, match whatever's actually there).

- [ ] **Step 2: Render it inside ConnectionsPanel, alongside Shopify's and Meta's**

In both of `ConnectionsPanel`'s return branches (added to by the Meta plan's Task 10),
add `<GoogleConnectButton clientId={clientId} connections={connections} />` next to the
existing `<MetaConnectButton .../>` line, inside the same `space-y-2` wrapper div.

- [ ] **Step 3: Verify manually in the browser**

Log in, open a client's detail dialog, confirm Shopify/Meta/Google connect rows/status all
show simultaneously and independently, and clicking "Connect Google Ads" redirects to
Google's real consent screen (approve it there manually — the plan's required manual e2e
checkpoint for Google).

- [ ] **Step 4: Run tsc and build**

```bash
cd /tmp/d2c-live && npx tsc --noEmit -p tsconfig.app.json && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/manage-clients.tsx
git commit -m "feat: add Connect Google Ads UI alongside Shopify's and Meta's connect panels"
```

---

## What comes after this plan

All three platform integrations from the original design spec (Shopify, Meta Ads, Google
Ads) are now built. Remaining known gaps across the rollout, tracked as candidate
follow-ups rather than blocking any of these three plans: Shopify's sync pagination (>250
orders truncates), Meta's rate-limit backoff (deferred explicitly in that plan), Google's
simplified single-customer resolution (no MCC hierarchy traversal), and courier
integrations (out of scope for the entire rollout per the original spec's Non-goals).
