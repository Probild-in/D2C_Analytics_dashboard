# Shopify Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mock Sales/Orders/Products/Geography data with real Shopify data, via a
real OAuth connect flow, a real sync job, and the shared connector-registry/dispatch-route
plumbing that every future platform integration (Meta, Google) will reuse.

**Architecture:** Extends the existing Express modular monolith. A `ShopifyConnector`
implements the foundation's already-defined `Connector` interface. Two new generic routes
(`POST /api/clients/:id/connections/:platform/authorize`, `GET
/api/integrations/:platform/callback`) dispatch to whichever connector a plain lookup
registry resolves for `:platform` — Meta/Google plug into this same registry later without
touching these routes again. An in-process `node-cron` scheduler runs every connected
client's `sync()` hourly. Four new read endpoints (`/sales`, `/orders`, `/products`,
`/geography`) replace the equivalent `mock.ts` functions with real queries over
`shopify_orders`/`shopify_order_line_items`.

**Tech Stack:** Node.js/Express/TypeScript backend (existing), Postgres via `pg` (existing),
`jose` for the signed state parameter (already a dependency), `node-cron` (new dependency),
native `fetch` for Shopify's REST Admin API (no new HTTP client needed), React/TypeScript
frontend (existing).

**Spec:** `docs/superpowers/specs/2026-09-02-platform-integrations-design.md`

## Global Constraints

- Every error response uses the shared `HttpError` class → `{ "error": { "code", "message" } }` — never a raw/uncaught error shape.
- OAuth tokens are encrypted with the existing `encryptToken`/`decryptToken` (`server/src/lib/crypto.ts`) before being written to `platform_connections.access_token`/`refresh_token` — never store or log a raw token.
- Every route scoping a client goes through the existing `assertClientAccess(pool, userId, clientId)` (`server/src/lib/access.ts`) — a client outside the caller's access must 404, never leak existence.
- OAuth callback failures (state verification failure, token exchange failure, account-limit exceeded) redirect the browser to `${FRONTEND_URL}/#/manage-clients?connection=error&message=...` and must never leave a half-created `platform_connections` row.
- Shopify tokens do not expire under normal use (only on app uninstall) — `ShopifyConnector.handleCallback()` never returns a `refreshToken` or `expiresAt`.
- All tests run against `TEST_DATABASE_URL` via `resetTestDb()`, no live Shopify API calls in the test suite — Shopify's HTTP calls are mocked with `vi.stubGlobal("fetch", ...)`.
- Manual end-to-end verification against the real Shopify dev store is required before this plan is considered done — this cannot be automated and is not skippable.

---

## File Structure

New files this plan creates:
- `server/migrations/002_shopify_customer_id.sql` — one new nullable column, needed for real new-vs-returning-customer computation.
- `server/src/lib/state-token.ts` — signs/verifies the OAuth `state` parameter.
- `server/src/integrations/shopify.ts` — the `ShopifyConnector` (all four `Connector` methods).
- `server/src/lib/connector-registry.ts` — the platform → connector lookup map.
- `server/src/routes/integrations.ts` — the generic `GET /api/integrations/:platform/callback` route (new top-level mount, not nested under `/api/clients`).
- `server/src/scheduler.ts` — the `node-cron` job that syncs every connected connection on an interval.
- `server/src/routes/shopify-data.ts` — the four real read endpoints (`/sales`, `/orders`, `/products`, `/geography`), grouped together since all four are simple queries over the same two Shopify tables.
- `src/hooks/use-client-resource.ts` — a small generic `fetch`-with-loading-state hook, shared by every page in this plan instead of duplicating fetch boilerplate four times.

Modified files:
- `server/test/helpers/test-db.ts` — generalized to apply every `*.sql` file in `migrations/`, not just one hardcoded filename (needed the moment a second migration file exists).
- `server/src/routes/connections.ts` — adds the `POST /:platform/authorize` route alongside the existing `GET /`.
- `server/src/index.ts` — mounts `integrations.ts`, `shopify-data.ts`, and starts the scheduler.
- `server/.env.example` — documents `STATE_SIGNING_SECRET`, `FRONTEND_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`.
- `server/package.json` — adds `node-cron` + `@types/node-cron`.
- `src/hooks/use-period-data.ts` — single-client branch now fetches `/api/clients/:id/sales` instead of calling `getSalesSeries` from `mock.ts`. The `isAllClients` branch is unchanged (still `getAllClientsSalesSeries` — out of scope for this plan).
- `src/pages/sales.tsx`, `src/pages/products.tsx`, `src/pages/geography.tsx`, `src/pages/operations.tsx` — their `getOrders`/`getProducts`/`getGeoBreakdown` calls swap to the new shared hook. `operations.tsx`'s `getCourierBreakdown` call is untouched (courier stays stubbed).
- `src/pages/manage-clients.tsx` — `ClientDetailDialog`'s static `client.integrations` badge list is replaced with a real fetch from `GET /api/clients/:id/connections` plus a "Connect Shopify" button.

---

### Task 1: Add `shopify_customer_id` column and generalize test migrations

New-vs-returning-customer computation (used by the `/sales` endpoint in Task 8, and
displayed on the Dashboard's "Customers" card) needs a stable per-customer identifier.
`shopify_orders.customer_name` alone can't distinguish two different customers who share a
display name. This task adds the column and teaches the test harness to apply more than
one migration file, since every later task's tests depend on it.

**Files:**
- Create: `server/migrations/002_shopify_customer_id.sql`
- Modify: `server/test/helpers/test-db.ts`
- Test: `server/test/db.test.ts` (existing file — add one assertion)

**Interfaces:**
- Consumes: nothing new.
- Produces: `shopify_orders.shopify_customer_id` (nullable text — guest checkouts on Shopify have no customer object at all, so this must be nullable). Every later task that reads/writes `shopify_orders` includes this column.

- [ ] **Step 1: Write the failing test**

Add to `server/test/db.test.ts` (append inside whatever `describe` block already covers
`shopify_orders`, or as its own `describe` if the file doesn't have one for this table —
check the file first):

```typescript
it("shopify_orders has a nullable shopify_customer_id column", async () => {
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('test-client', 'Test', 'Fashion', 'bg-violet-500', 'T')`,
  );
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('33333333-3333-3333-3333-333333333333', 'Owner', 'owner@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('44444444-4444-4444-4444-444444444444', 'test-client', 'shopify', 'connected', 'test.myshopify.com')`,
  );
  const result = await testPool.query(
    `insert into shopify_orders
       (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id)
     values ('test-client', '44444444-4444-4444-4444-444444444444', '1001', 'Guest Checkout', now(), 500, 'Delivered', 'Prepaid', null)
     returning shopify_customer_id`,
  );
  expect(result.rows[0].shopify_customer_id).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- db.test.ts
```
Expected: FAIL — `column "shopify_customer_id" of relation "shopify_orders" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- server/migrations/002_shopify_customer_id.sql
alter table shopify_orders add column shopify_customer_id text;
```

- [ ] **Step 4: Generalize `resetTestDb()` to apply every migration file in order**

Replace the whole file `server/test/helpers/test-db.ts` with:

```typescript
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

export const testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

export async function resetTestDb() {
  await testPool.query(`
    drop schema public cascade;
    create schema public;
    create extension if not exists pgcrypto;
  `);
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    await testPool.query(sql);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```
Expected: full suite passes (this touches shared test infra — confirm nothing else broke, not just the new test).

- [ ] **Step 6: Commit**

```bash
git add server/migrations/002_shopify_customer_id.sql server/test/helpers/test-db.ts server/test/db.test.ts
git commit -m "feat(server): add shopify_customer_id column, apply all migrations in tests"
```

---

### Task 2: Signed OAuth state parameter

**Files:**
- Create: `server/src/lib/state-token.ts`
- Test: `server/test/lib/state-token.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `signState(payload: { clientId: string; platform: string; teamMemberId: string }): Promise<string>` and `verifyState(token: string): Promise<{ clientId: string; platform: string; teamMemberId: string }>` (throws on invalid/expired/tampered tokens). Task 4's dispatch routes are the only other consumer.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/lib/state-token.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { signState, verifyState } from "../../src/lib/state-token.js";

beforeEach(() => {
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
});

describe("state-token", () => {
  it("round-trips a signed state token", async () => {
    const token = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    const payload = await verifyState(token);
    expect(payload).toMatchObject({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
  });

  it("rejects a tampered token", async () => {
    const token = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    await expect(verifyState(tampered)).rejects.toThrow();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    process.env.STATE_SIGNING_SECRET = "a-completely-different-secret-value";
    await expect(verifyState(token)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test -- state-token.test.ts
```
Expected: FAIL — module `../../src/lib/state-token.js` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/lib/state-token.ts
import { SignJWT, jwtVerify } from "jose";

export interface StatePayload {
  clientId: string;
  platform: string;
  teamMemberId: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.STATE_SIGNING_SECRET;
  if (!secret) {
    throw new Error("STATE_SIGNING_SECRET environment variable must be set");
  }
  return new TextEncoder().encode(secret);
}

export async function signState(payload: StatePayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getSecret());
}

export async function verifyState(token: string): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, getSecret());
  return {
    clientId: payload.clientId as string,
    platform: payload.platform as string,
    teamMemberId: payload.teamMemberId as string,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npm test -- state-token.test.ts
```
Expected: PASS, 3/3.

- [ ] **Step 5: Document the new env var**

Add to `server/.env.example`:
```
# Signs the OAuth "state" parameter (separate from SUPABASE_JWT_SECRET — different
# purpose, different blast radius if either leaks).
STATE_SIGNING_SECRET=replace-with-a-long-random-string
```

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/state-token.ts server/test/lib/state-token.test.ts server/.env.example
git commit -m "feat(server): add signed OAuth state parameter helper"
```

---

### Task 3: `ShopifyConnector` — `getAuthUrl` and `handleCallback`

Builds the OAuth half of the connector. `sync()` and `disconnect()` are Task 5 — this
task's `sync` and `disconnect` are throwaway stubs that satisfy the `Connector` interface
so the file type-checks; Task 5 replaces them with real implementations.

**Files:**
- Create: `server/src/integrations/shopify.ts`
- Test: `server/test/integrations/shopify.test.ts`

**Interfaces:**
- Consumes: the `Connector` interface (`server/src/integrations/types.ts`, already exists — `getAuthUrl(clientId, state)`, `handleCallback(query)`, `sync(connectionId)`, `disconnect(connectionId)`).
- Produces: `shopifyConnector: Connector` with `platform: "shopify"`. Task 4 imports this exact export.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/integrations/shopify.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shopifyConnector } from "../../src/integrations/shopify.js";

beforeEach(() => {
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shopifyConnector.getAuthUrl", () => {
  it("builds a per-shop authorize URL with the requested scopes", () => {
    const url = shopifyConnector.getAuthUrl("test-shop.myshopify.com", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://test-shop.myshopify.com");
    expect(parsed.pathname).toBe("/admin/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("test-api-key");
    expect(parsed.searchParams.get("scope")).toBe("read_orders,read_products,read_customers");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/shopify/callback");
  });
});

describe("shopifyConnector.handleCallback", () => {
  it("exchanges the code for an access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://test-shop.myshopify.com/admin/oauth/access_token");
        return new Response(JSON.stringify({ access_token: "shpat_real_token", scope: "read_orders,read_products,read_customers" }), { status: 200 });
      }),
    );
    const result = await shopifyConnector.handleCallback({ shop: "test-shop.myshopify.com", code: "auth-code-123" });
    expect(result).toEqual({ externalAccountId: "test-shop.myshopify.com", accessToken: "shpat_real_token" });
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid request", { status: 400 })));
    await expect(shopifyConnector.handleCallback({ shop: "test-shop.myshopify.com", code: "bad-code" })).rejects.toThrow();
  });

  it("throws if the shop query param is missing", async () => {
    await expect(shopifyConnector.handleCallback({ code: "auth-code-123" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && npm test -- shopify.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/integrations/shopify.ts
import type { Connector } from "./types.js";

const SHOPIFY_SCOPES = "read_orders,read_products,read_customers";

function getRedirectUri(): string {
  const frontendApiUrl = process.env.PUBLIC_API_URL;
  if (!frontendApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${frontendApiUrl}/api/integrations/shopify/callback`;
}

function getCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("SHOPIFY_API_KEY and SHOPIFY_API_SECRET environment variables must be set");
  }
  return { apiKey, apiSecret };
}

export const shopifyConnector: Connector = {
  platform: "shopify",

  getAuthUrl(shopDomain: string, state: string): string {
    const { apiKey } = getCredentials();
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set("client_id", apiKey);
    url.searchParams.set("scope", SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>) {
    const shop = query.shop;
    const code = query.code;
    if (!shop || !code) {
      throw new Error("Shopify callback missing shop or code query parameter");
    }
    const { apiKey, apiSecret } = getCredentials();
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) {
      throw new Error(`Shopify token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string };
    return { externalAccountId: shop, accessToken: body.access_token };
  },

  async sync(_connectionId: string) {
    throw new Error("not implemented yet — see Task 5");
  },

  async disconnect(_connectionId: string) {
    throw new Error("not implemented yet — see Task 5");
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npm test -- shopify.test.ts
```
Expected: PASS, 4/4.

- [ ] **Step 5: Document the new env vars**

Add to `server/.env.example`:
```
SHOPIFY_API_KEY=replace-with-shopify-app-api-key
SHOPIFY_API_SECRET=replace-with-shopify-app-api-secret
# The backend's own public base URL — used to build the OAuth redirect_uri.
PUBLIC_API_URL=https://d2c.probild.in
```

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/shopify.ts server/test/integrations/shopify.test.ts server/.env.example
git commit -m "feat(server): add ShopifyConnector OAuth (getAuthUrl, handleCallback)"
```

---

### Task 4: Connector registry + generic dispatch routes

**Files:**
- Create: `server/src/lib/connector-registry.ts`
- Create: `server/src/routes/integrations.ts`
- Modify: `server/src/routes/connections.ts` (add the `authorize` route)
- Modify: `server/src/index.ts` (mount `integrations.ts`)
- Test: `server/test/routes/connections.test.ts` (append), `server/test/routes/integrations.test.ts` (new)

**Interfaces:**
- Consumes: `shopifyConnector` (Task 3), `signState`/`verifyState` (Task 2), `assertClientAccess` (existing), `encryptToken` (existing `server/src/lib/crypto.ts`).
- Produces: `connectors: Record<string, Connector>` (`server/src/lib/connector-registry.ts`) — Meta/Google plans add their own entry to this same object, they don't touch the dispatch routes.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/routes/connections.test.ts`:

```typescript
describe("POST /api/clients/:id/connections/:platform/authorize", () => {
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
    process.env.SHOPIFY_API_KEY = "test-api-key";
    process.env.SHOPIFY_API_SECRET = "test-api-secret";
    process.env.PUBLIC_API_URL = "https://d2c.probild.in";
    process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  });

  it("returns an authorize URL for a known platform", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({ shopDomain: "abc-fashion.myshopify.com" });
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
    expect(res.body.authorizeUrl).toContain("state=");
  });

  it("404s for an unknown platform", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/not-a-real-platform/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({ shopDomain: "abc-fashion.myshopify.com" });
    expect(res.status).toBe(404);
  });
});
```

Create `server/test/routes/integrations.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signState } from "../../src/lib/state-token.js";

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
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.FRONTEND_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/integrations/:platform/callback", () => {
  it("creates a connection and redirects to the frontend on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_real_token" }), { status: 200 })),
    );
    const state = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ shop: "abc-fashion.myshopify.com", code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/manage-clients");
    expect(res.headers.location).toContain("connection=success");

    const conn = await testPool.query("select * from platform_connections where client_id = $1", ["abc-fashion"]);
    expect(conn.rowCount).toBe(1);
    expect(conn.rows[0].status).toBe("connected");
    expect(conn.rows[0].access_token).not.toBe("shpat_real_token");
    expect(conn.rows[0].access_token.length).toBeGreaterThan(0);
  });

  it("redirects with an error and creates no connection when state is invalid", async () => {
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ shop: "abc-fashion.myshopify.com", code: "auth-code", state: "not-a-real-token" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    const conn = await testPool.query("select * from platform_connections");
    expect(conn.rowCount).toBe(0);
  });

  it("redirects with an error and creates no connection when the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    const state = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ shop: "abc-fashion.myshopify.com", code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    const conn = await testPool.query("select * from platform_connections");
    expect(conn.rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- connections.test.ts integrations.test.ts
```
Expected: FAIL — route doesn't exist yet / module not found.

- [ ] **Step 3: Write the connector registry**

```typescript
// server/src/lib/connector-registry.ts
import type { Connector } from "../integrations/types.js";
import { shopifyConnector } from "../integrations/shopify.js";

export const connectors: Record<string, Connector> = {
  shopify: shopifyConnector,
};
```

- [ ] **Step 4: Add the `authorize` route to `server/src/routes/connections.ts`**

Replace the whole file with:

```typescript
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { connectors } from "../lib/connector-registry.js";
import { signState } from "../lib/state-token.js";

const router = Router({ mergeParams: true });

router.get("/", requireAuth, async (req, res, next) => {
  try {
    await assertClientAccess(pool, req.auth!.userId, req.params.id);
    const result = await pool.query(
      `select platform, status, external_account_id, last_synced_at, created_at
       from platform_connections where client_id = $1 order by created_at`,
      [req.params.id],
    );
    res.json(
      result.rows.map((r) => ({
        platform: r.platform,
        status: r.status,
        externalAccountId: r.external_account_id,
        lastSyncedAt: r.last_synced_at,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:platform/authorize", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }

    const state = await signState({ clientId, platform, teamMemberId: req.auth!.userId });
    const shopDomain = (req.body as { shopDomain?: string }).shopDomain;
    const authorizeUrl = connector.getAuthUrl(shopDomain ?? clientId, state);
    res.json({ authorizeUrl });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 5: Write `server/src/routes/integrations.ts`**

```typescript
import { Router } from "express";
import pool from "../db.js";
import { connectors } from "../lib/connector-registry.js";
import { verifyState } from "../lib/state-token.js";
import { encryptToken } from "../lib/crypto.js";

const router = Router();

router.get("/:platform/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const platform = req.params.platform;
  const query = req.query as Record<string, string>;

  const redirectError = (message: string) => {
    const url = new URL(`${frontendUrl}/#/manage-clients`);
    url.searchParams.set("connection", "error");
    url.searchParams.set("message", message);
    res.redirect(url.toString());
  };

  let statePayload;
  try {
    statePayload = await verifyState(query.state);
  } catch {
    redirectError("Invalid or expired connection request");
    return;
  }

  if (statePayload.platform !== platform) {
    redirectError("Platform mismatch");
    return;
  }

  const connector = connectors[platform];
  if (!connector) {
    redirectError("Unknown platform");
    return;
  }

  try {
    const { externalAccountId, accessToken, refreshToken, expiresAt } = await connector.handleCallback(query);
    await pool.query(
      `insert into platform_connections
         (client_id, platform, status, access_token, refresh_token, token_expires_at, external_account_id, connected_by)
       values ($1, $2, 'connected', $3, $4, $5, $6, $7)
       on conflict (client_id, platform, external_account_id)
       do update set status = 'connected', access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at`,
      [
        statePayload.clientId,
        platform,
        encryptToken(accessToken),
        refreshToken ? encryptToken(refreshToken) : null,
        expiresAt ?? null,
        externalAccountId,
        statePayload.teamMemberId,
      ],
    );
    const url = new URL(`${frontendUrl}/#/manage-clients`);
    url.searchParams.set("connection", "success");
    res.redirect(url.toString());
  } catch {
    redirectError("Failed to connect — please try again");
  }
});

export default router;
```

- [ ] **Step 6: Mount the new route in `server/src/index.ts`**

```typescript
import integrationsRouter from "./routes/integrations.js";
// ... alongside the other router imports

app.use("/api/integrations", integrationsRouter);
// ... mounted before the error-handling middleware and the NODE_ENV listen guard, same as every other router
```

- [ ] **Step 7: Document `FRONTEND_URL`**

Add to `server/.env.example`:
```
FRONTEND_URL=https://d2c.probild.in
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```
Expected: full suite passes.

- [ ] **Step 9: Commit**

```bash
git add server/src/lib/connector-registry.ts server/src/routes/integrations.ts server/src/routes/connections.ts server/src/index.ts server/test/routes/connections.test.ts server/test/routes/integrations.test.ts server/.env.example
git commit -m "feat(server): add connector registry and generic OAuth dispatch routes"
```

---

### Task 5: Shopify `sync()` and `disconnect()`

**Files:**
- Modify: `server/src/integrations/shopify.ts` (replace the stub `sync`/`disconnect`)
- Test: `server/test/integrations/shopify.test.ts` (append)

**Interfaces:**
- Consumes: `pool` (`server/src/db.ts`), `decryptToken` (`server/src/lib/crypto.ts`).
- Produces: real `sync(connectionId): Promise<{ recordsSynced: number }>` and `disconnect(connectionId): Promise<void>`. Task 6's manual "sync now" endpoint and Task 7's scheduler both call `sync` by connection id only — no other inputs.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/integrations/shopify.test.ts`:

```typescript
describe("shopifyConnector.sync", () => {
  beforeEach(async () => {
    await resetTestDb();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
  });

  it("upserts orders and line items from the Shopify Orders API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("https://abc-fashion.myshopify.com/admin/api/");
        expect(url).toContain("/orders.json");
        return new Response(
          JSON.stringify({
            orders: [
              {
                id: 1001,
                created_at: "2026-08-15T10:00:00Z",
                total_price: "1499.00",
                financial_status: "paid",
                fulfillment_status: "fulfilled",
                cancelled_at: null,
                customer: { id: 9001, first_name: "Priya", last_name: "Shah" },
                shipping_address: { city: "Mumbai", province: "Maharashtra" },
                payment_gateway_names: ["shopify_payments"],
                line_items: [{ id: 501, title: "Cotton Kurta", quantity: 2, price: "749.50" }],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(1);

    const orders = await testPool.query("select * from shopify_orders where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0]).toMatchObject({
      shopify_order_id: "1001",
      customer_name: "Priya Shah",
      amount: 1499,
      status: "Delivered",
      payment_method: "Prepaid",
      city: "Mumbai",
      state: "Maharashtra",
      shopify_customer_id: "9001",
    });

    const lineItems = await testPool.query("select * from shopify_order_line_items where order_id = $1", [orders.rows[0].id]);
    expect(lineItems.rowCount).toBe(1);
    expect(lineItems.rows[0]).toMatchObject({ product_name: "Cotton Kurta", quantity: 2, price: 750 });
  });

  it("marks an unfulfilled, non-cancelled order as Dispatched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            orders: [
              {
                id: 1002,
                created_at: "2026-08-16T10:00:00Z",
                total_price: "500.00",
                financial_status: "pending",
                fulfillment_status: null,
                cancelled_at: null,
                customer: null,
                shipping_address: null,
                payment_gateway_names: ["cash_on_delivery"],
                line_items: [],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    const orders = await testPool.query("select * from shopify_orders where shopify_order_id = '1002'");
    expect(orders.rows[0]).toMatchObject({ status: "Dispatched", payment_method: "COD", customer_name: "Guest", shopify_customer_id: null });
  });

  it("marks a cancelled order as Cancelled regardless of fulfillment status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            orders: [
              {
                id: 1003,
                created_at: "2026-08-17T10:00:00Z",
                total_price: "300.00",
                financial_status: "voided",
                fulfillment_status: null,
                cancelled_at: "2026-08-17T12:00:00Z",
                customer: null,
                shipping_address: null,
                payment_gateway_names: [],
                line_items: [],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    const orders = await testPool.query("select status from shopify_orders where shopify_order_id = '1003'");
    expect(orders.rows[0].status).toBe("Cancelled");
  });

  it("re-syncing the same order updates it in place, not duplicated", async () => {
    const makeResponse = (financial: string) =>
      new Response(
        JSON.stringify({
          orders: [
            {
              id: 1004,
              created_at: "2026-08-18T10:00:00Z",
              total_price: "800.00",
              financial_status: financial,
              fulfillment_status: "fulfilled",
              cancelled_at: null,
              customer: null,
              shipping_address: null,
              payment_gateway_names: ["shopify_payments"],
              line_items: [],
            },
          ],
        }),
        { status: 200 },
      );
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse("pending")));
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse("paid")));
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");

    const orders = await testPool.query("select * from shopify_orders where shopify_order_id = '1004'");
    expect(orders.rowCount).toBe(1);
  });

  it("updates last_synced_at on the connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");
    const conn = await testPool.query("select last_synced_at from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
  });
});

describe("shopifyConnector.disconnect", () => {
  beforeEach(async () => {
    await resetTestDb();
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
  });

  it("marks the connection disconnected", async () => {
    await shopifyConnector.disconnect("55555555-5555-5555-5555-555555555555");
    const conn = await testPool.query("select status from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].status).toBe("disconnected");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify.test.ts
```
Expected: FAIL — `sync`/`disconnect` throw "not implemented yet".

- [ ] **Step 3: Replace the stub `sync`/`disconnect` in `server/src/integrations/shopify.ts`**

Add these imports at the top of the file:
```typescript
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
```

Replace the two stub methods:

```typescript
  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, external_account_id, last_synced_at from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);

    const params = new URLSearchParams({ status: "any", limit: "250" });
    if (conn.last_synced_at) {
      params.set("updated_at_min", new Date(conn.last_synced_at).toISOString());
    }
    const res = await fetch(`https://${conn.external_account_id}/admin/api/2024-10/orders.json?${params}`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!res.ok) {
      throw new Error(`Shopify orders fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as { orders: ShopifyOrder[] };

    let recordsSynced = 0;
    for (const order of body.orders) {
      const status = mapOrderStatus(order);
      const paymentMethod = mapPaymentMethod(order.payment_gateway_names);
      const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}`.trim() : "Guest";

      const orderResult = await pool.query(
        `insert into shopify_orders
           (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state, shopify_customer_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (connection_id, shopify_order_id)
         do update set customer_name = excluded.customer_name, amount = excluded.amount, status = excluded.status,
           payment_method = excluded.payment_method, city = excluded.city, state = excluded.state
         returning id`,
        [
          conn.client_id,
          connectionId,
          String(order.id),
          customerName,
          order.created_at,
          Math.round(parseFloat(order.total_price)),
          status,
          paymentMethod,
          order.shipping_address?.city ?? null,
          order.shipping_address?.province ?? null,
          order.customer ? String(order.customer.id) : null,
        ],
      );
      const orderId = orderResult.rows[0].id;

      for (const item of order.line_items) {
        await pool.query(
          `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price)
           values ($1, $2, $3, $4, $5)
           on conflict (order_id, shopify_line_item_id)
           do update set product_name = excluded.product_name, quantity = excluded.quantity, price = excluded.price`,
          [orderId, String(item.id), item.title, item.quantity, Math.round(parseFloat(item.price))],
        );
      }
      recordsSynced++;
    }

    await pool.query("update platform_connections set last_synced_at = now() where id = $1", [connectionId]);
    return { recordsSynced };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
```

Add these types and helper functions near the top of the file, above `shopifyConnector`:

```typescript
interface ShopifyOrder {
  id: number;
  created_at: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  customer: { id: number; first_name: string; last_name: string } | null;
  shipping_address: { city: string; province: string } | null;
  payment_gateway_names: string[];
  line_items: { id: number; title: string; quantity: number; price: string }[];
}

// Shopify's core Orders API only exposes financial_status/fulfillment_status/cancelled_at —
// it has no native concept of NDR/RTO/Out-for-Delivery. Those need a courier integration,
// which is explicitly out of scope. This maps what Shopify actually tells us onto the
// closest fit in the existing OrderStatus enum, rather than fabricating granularity we
// don't have.
function mapOrderStatus(order: ShopifyOrder): string {
  if (order.cancelled_at) return "Cancelled";
  if (order.fulfillment_status === "fulfilled") return "Delivered";
  return "Dispatched";
}

function mapPaymentMethod(gatewayNames: string[]): string {
  const isCod = gatewayNames.some((name) => name.toLowerCase().includes("cash") || name.toLowerCase().includes("cod"));
  return isCod ? "COD" : "Prepaid";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify.test.ts
```
Expected: PASS, all cases including the two new `describe` blocks.

- [ ] **Step 5: Run the full suite**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```
Expected: full suite passes.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/shopify.ts server/test/integrations/shopify.test.ts
git commit -m "feat(server): implement Shopify sync and disconnect"
```

---

### Task 6: Manual "Sync now" endpoint

**Files:**
- Create: `server/src/routes/sync.ts`
- Modify: `server/src/index.ts` (mount it)
- Test: `server/test/routes/sync.test.ts`

**Interfaces:**
- Consumes: `connectors` (Task 4), `assertClientAccess` (existing).
- Produces: `POST /api/clients/:id/connections/:platform/sync`, rate-limited to once per 5 minutes per connection (per the spec's manual "Sync now" requirement) — no other task depends on this route's internals, only its existence for manual verification.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/routes/sync.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { encryptToken } from "../../src/lib/crypto.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
    [encryptToken("shpat_real_token")],
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/clients/:id/connections/:platform/sync", () => {
  it("runs the connector's sync and returns records synced", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recordsSynced: 0 });
  });

  it("404s when there's no connection for that platform", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/google/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("429s a second manual sync within 5 minutes of the last one", async () => {
    await testPool.query("update platform_connections set last_synced_at = now() - interval '2 minutes' where id = $1", [
      "55555555-5555-5555-5555-555555555555",
    ]);
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(429);
  });

  it("allows a manual sync when the last one was more than 5 minutes ago", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    await testPool.query("update platform_connections set last_synced_at = now() - interval '10 minutes' where id = $1", [
      "55555555-5555-5555-5555-555555555555",
    ]);
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- sync.test.ts
```
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Write `server/src/routes/sync.ts`**

```typescript
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { connectors } from "../lib/connector-registry.js";

const router = Router({ mergeParams: true });
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;

router.post("/:platform/sync", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }

    const connResult = await pool.query(
      "select id, last_synced_at from platform_connections where client_id = $1 and platform = $2",
      [clientId, platform],
    );
    if (connResult.rowCount === 0) {
      throw new HttpError(404, "not_connected", `No ${platform} connection for this client`);
    }

    const { id, last_synced_at } = connResult.rows[0];
    if (last_synced_at && Date.now() - new Date(last_synced_at).getTime() < MIN_SYNC_INTERVAL_MS) {
      throw new HttpError(429, "sync_rate_limited", "This connection was synced less than 5 minutes ago");
    }

    const result = await connector.sync(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount it in `server/src/index.ts`**

```typescript
import syncRouter from "./routes/sync.js";
// ... alongside the other imports

app.use("/api/clients/:id/connections", syncRouter);
// mount this AFTER the existing connectionsRouter mount on the same path — Express tries
// routers in mount order, and connections.ts's own routes (GET /, POST /:platform/authorize)
// don't overlap with this router's POST /:platform/sync path, so order between the two
// doesn't actually matter here, but keep it directly below the connections mount for readability.
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```
Expected: full suite passes.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/sync.ts server/src/index.ts server/test/routes/sync.test.ts
git commit -m "feat(server): add manual sync-now endpoint"
```

---

### Task 7: Scheduled sync

**Files:**
- Create: `server/src/scheduler.ts`
- Modify: `server/src/index.ts` (start the scheduler)
- Modify: `server/package.json` (add `node-cron`)
- Test: `server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `connectors` (Task 4), `pool` (existing).
- Produces: `startScheduler(): void` — no other task depends on this beyond `index.ts` calling it once at startup.

- [ ] **Step 1: Install `node-cron`**

```bash
cd server && npm install node-cron && npm install --save-dev @types/node-cron
```

- [ ] **Step 2: Write the failing test**

```typescript
// server/test/scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";
import { encryptToken } from "../src/lib/crypto.js";
import { runScheduledSyncs } from "../src/scheduler.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runScheduledSyncs", () => {
  it("syncs every connected connection for the given platform", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));

    await runScheduledSyncs("shopify");

    const conn = await testPool.query("select last_synced_at from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
  });

  it("skips disconnected connections", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('66666666-6666-6666-6666-666666666666', 'abc-fashion', 'shopify', 'disconnected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await runScheduledSyncs("shopify");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs to sync_logs and flips status to error when a sync fails", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('77777777-7777-7777-7777-777777777777', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));

    await runScheduledSyncs("shopify");

    const conn = await testPool.query("select status from platform_connections where id = $1", ["77777777-7777-7777-7777-777777777777"]);
    expect(conn.rows[0].status).toBe("error");
    const logs = await testPool.query("select * from sync_logs where connection_id = $1", ["77777777-7777-7777-7777-777777777777"]);
    expect(logs.rowCount).toBe(1);
    expect(logs.rows[0].error).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- scheduler.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Write `server/src/scheduler.ts`**

```typescript
import cron from "node-cron";
import pool from "./db.js";
import { connectors } from "./lib/connector-registry.js";

export async function runScheduledSyncs(platform: string) {
  const connector = connectors[platform];
  if (!connector) return;

  const result = await pool.query(
    "select id from platform_connections where platform = $1 and status = 'connected'",
    [platform],
  );

  for (const row of result.rows) {
    const startedAt = new Date();
    try {
      await connector.sync(row.id);
    } catch (err) {
      await pool.query("update platform_connections set status = 'error' where id = $1", [row.id]);
      await pool.query(
        "insert into sync_logs (connection_id, started_at, finished_at, error) values ($1, $2, now(), $3)",
        [row.id, startedAt, err instanceof Error ? err.message : String(err)],
      );
    }
  }
}

export function startScheduler() {
  // Shopify order data is time-sensitive — hourly.
  cron.schedule("0 * * * *", () => {
    runScheduledSyncs("shopify").catch((err) => console.error("Shopify scheduled sync failed:", err));
  });
}
```

- [ ] **Step 5: Start the scheduler in `server/src/index.ts`**

```typescript
import { startScheduler } from "./scheduler.js";
// ... near the bottom of the file

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`server listening on ${port}`));
  startScheduler();
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```
Expected: full suite passes.

- [ ] **Step 7: Commit**

```bash
git add server/src/scheduler.ts server/src/index.ts server/package.json server/package-lock.json server/test/scheduler.test.ts
git commit -m "feat(server): add hourly Shopify sync scheduler"
```

---

### Task 8: `GET /api/clients/:id/sales`

Real per-day sales series, replacing `getSalesSeries` for single-client views. Uses
`generate_series` so every day in the window appears (including zero-order days), and
computes new-vs-returning customers from `shopify_customer_id` (Task 1).

**Files:**
- Create: `server/src/routes/shopify-data.ts`
- Modify: `server/src/index.ts` (mount it)
- Test: `server/test/routes/shopify-data.test.ts`

**Interfaces:**
- Consumes: `assertClientAccess` (existing).
- Produces: `GET /api/clients/:id/sales?days=N` → `SalesPoint[]` (see `src/data/types.ts` for the exact shape this must match — `date, grossSales, netSales, orders, adSpend, newCustomers, returningCustomers, codOrders, prepaidOrders, cancelledOrders, rtoOrders`, camelCase). Task 11 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/routes/shopify-data.test.ts
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
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
});

describe("GET /api/clients/:id/sales", () => {
  it("returns one point per day, including zero-order days, with new vs returning customers", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, shopify_customer_id) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now() - interval '1 day', 1000, 'Delivered', 'Prepaid', '9001'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Priya Shah', now(), 500, 'Delivered', 'COD', '9001'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '3', 'Amit Rao', now(), 800, 'Cancelled', 'Prepaid', '9002')`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=3")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    const today = res.body[res.body.length - 1];
    expect(today.orders).toBe(2);
    expect(today.netSales).toBe(500);
    expect(today.cancelledOrders).toBe(1);
    expect(today.newCustomers).toBe(1);
    expect(today.returningCustomers).toBe(1);
    expect(today.adSpend).toBe(0);

    const yesterday = res.body[res.body.length - 2];
    expect(yesterday.orders).toBe(1);
    expect(yesterday.newCustomers).toBe(1);

    const threeDaysAgo = res.body[0];
    expect(threeDaysAgo.orders).toBe(0);
    expect(threeDaysAgo.netSales).toBe(0);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/sales?days=7")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Write `server/src/routes/shopify-data.ts`**

```typescript
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";

const router = Router({ mergeParams: true });

router.get("/sales", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const days = Math.max(1, Math.min(730, Number(req.query.days) || 90));

    const result = await pool.query(
      `with days as (
         select generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date as day
       ),
       orders_by_day as (
         select
           order_date::date as day,
           count(*) filter (where status <> 'Cancelled') as orders,
           coalesce(sum(amount) filter (where status <> 'Cancelled'), 0) as net_sales,
           coalesce(sum(amount), 0) as gross_sales,
           count(*) filter (where status = 'Cancelled') as cancelled_orders,
           count(*) filter (where payment_method = 'COD' and status <> 'Cancelled') as cod_orders,
           count(*) filter (where payment_method = 'Prepaid' and status <> 'Cancelled') as prepaid_orders,
           count(*) filter (
             where status <> 'Cancelled' and shopify_customer_id is not null
             and order_date::date = (
               select min(o2.order_date)::date from shopify_orders o2
               where o2.client_id = shopify_orders.client_id and o2.shopify_customer_id = shopify_orders.shopify_customer_id
             )
           ) as new_customers,
           count(*) filter (
             where status <> 'Cancelled' and shopify_customer_id is not null
             and order_date::date <> (
               select min(o2.order_date)::date from shopify_orders o2
               where o2.client_id = shopify_orders.client_id and o2.shopify_customer_id = shopify_orders.shopify_customer_id
             )
           ) as returning_customers
         from shopify_orders
         where client_id = $1 and order_date >= current_date - ($2::int - 1)
         group by order_date::date
       )
       select
         days.day,
         coalesce(orders_by_day.gross_sales, 0)::int as gross_sales,
         coalesce(orders_by_day.net_sales, 0)::int as net_sales,
         coalesce(orders_by_day.orders, 0)::int as orders,
         coalesce(orders_by_day.new_customers, 0)::int as new_customers,
         coalesce(orders_by_day.returning_customers, 0)::int as returning_customers,
         coalesce(orders_by_day.cod_orders, 0)::int as cod_orders,
         coalesce(orders_by_day.prepaid_orders, 0)::int as prepaid_orders,
         coalesce(orders_by_day.cancelled_orders, 0)::int as cancelled_orders
       from days
       left join orders_by_day on orders_by_day.day = days.day
       order by days.day`,
      [clientId, days],
    );

    res.json(
      result.rows.map((r) => ({
        date: r.day.toISOString().slice(0, 10),
        grossSales: r.gross_sales,
        netSales: r.net_sales,
        orders: r.orders,
        adSpend: 0,
        newCustomers: r.new_customers,
        returningCustomers: r.returning_customers,
        codOrders: r.cod_orders,
        prepaidOrders: r.prepaid_orders,
        cancelledOrders: r.cancelled_orders,
        rtoOrders: 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
```

`adSpend` and `rtoOrders` are always `0` — ad spend belongs to the Meta/Google plans, and
real RTO tracking needs a courier integration (stubbed). Both are explicit, not silently
wrong: the frontend already renders `0` gracefully wherever these appear.

- [ ] **Step 4: Mount it in `server/src/index.ts`**

```typescript
import shopifyDataRouter from "./routes/shopify-data.js";
// ... alongside the other imports

app.use("/api/clients/:id", shopifyDataRouter);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/shopify-data.ts server/src/index.ts server/test/routes/shopify-data.test.ts
git commit -m "feat(server): add GET /api/clients/:id/sales real endpoint"
```

---

### Task 9: `GET /api/clients/:id/orders`

**Files:**
- Modify: `server/src/routes/shopify-data.ts` (append the route)
- Test: `server/test/routes/shopify-data.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/clients/:id/orders?limit=N` → `Order[]` matching `src/data/types.ts` exactly (`id, clientId, customer, date, amount, status, payment, city, state, courier, product`). Task 12 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/shopify-data.test.ts`:

```typescript
describe("GET /api/clients/:id/orders", () => {
  it("returns orders newest first, with a representative product name", async () => {
    await testPool.query(
      `insert into shopify_orders
         (id, client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state) values
       ('88888888-8888-8888-8888-888888888888', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now() - interval '1 day', 1000, 'Delivered', 'Prepaid', 'Mumbai', 'Maharashtra'),
       ('99999999-9999-9999-9999-999999999999', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Dispatched', 'COD', 'Pune', 'Maharashtra')`,
    );
    await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price) values
       ('99999999-9999-9999-9999-999999999999', 'li-1', 'Cotton Kurta', 1, 500)`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/orders?limit=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      clientId: "abc-fashion",
      customer: "Amit Rao",
      amount: 500,
      status: "Dispatched",
      payment: "COD",
      city: "Pune",
      state: "Maharashtra",
      product: "Cotton Kurta",
    });
    expect(res.body[1].customer).toBe("Priya Shah");
  });

  it("returns an empty array for a client with no synced orders", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/orders")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Append the route to `server/src/routes/shopify-data.ts`**

```typescript
router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 60));

    const result = await pool.query(
      `select
         o.id, o.customer_name, o.order_date, o.amount, o.status, o.payment_method, o.city, o.state,
         (select li.product_name from shopify_order_line_items li where li.order_id = o.id order by li.id limit 1) as product_name
       from shopify_orders o
       where o.client_id = $1
       order by o.order_date desc
       limit $2`,
      [clientId, limit],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        clientId,
        customer: r.customer_name,
        date: r.order_date.toISOString(),
        amount: r.amount,
        status: r.status,
        payment: r.payment_method,
        city: r.city ?? "",
        state: r.state ?? "",
        courier: "",
        product: r.product_name ?? "",
      })),
    );
  } catch (err) {
    next(err);
  }
});
```

`courier` is always `""` — courier data needs a courier integration, which is stubbed.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/shopify-data.ts server/test/routes/shopify-data.test.ts
git commit -m "feat(server): add GET /api/clients/:id/orders real endpoint"
```

---

### Task 10: `GET /api/clients/:id/products`

**Files:**
- Modify: `server/src/routes/shopify-data.ts` (append the route)
- Test: `server/test/routes/shopify-data.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/clients/:id/products` → array matching `src/data/types.ts`'s `Product` shape (`id, name, image, category, orders, sales, netSales, rtoPercent, cancellationPercent, trend`), aggregated across all synced orders. Task 12 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/shopify-data.test.ts`:

```typescript
describe("GET /api/clients/:id/products", () => {
  it("aggregates line items into per-product totals", async () => {
    await testPool.query(
      `insert into shopify_orders (id, client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1500, 'Delivered', 'Prepaid'),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Cancelled', 'COD')`,
    );
    await testPool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price) values
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'li-1', 'Cotton Kurta', 2, 750),
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'li-2', 'Cotton Kurta', 1, 500)`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/products")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: "Cotton Kurta",
      orders: 3,
      sales: 2000,
      netSales: 1500,
      cancellationPercent: expect.closeTo(33.33, 1),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Append the route to `server/src/routes/shopify-data.ts`**

```typescript
router.get("/products", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const result = await pool.query(
      `select
         li.product_name,
         sum(li.quantity)::int as orders,
         sum(li.quantity * li.price)::int as sales,
         sum(li.quantity * li.price) filter (where o.status <> 'Cancelled')::int as net_sales,
         count(*) filter (where o.status = 'RTO Initiated' or o.status = 'RTO Delivered')::int as rto_count,
         count(*) filter (where o.status = 'Cancelled')::int as cancelled_count,
         count(*)::int as total_count
       from shopify_order_line_items li
       join shopify_orders o on o.id = li.order_id
       where o.client_id = $1
       group by li.product_name
       order by sales desc`,
      [clientId],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.product_name,
        name: r.product_name,
        image: "",
        category: "",
        orders: r.orders,
        sales: r.sales,
        netSales: r.net_sales ?? 0,
        rtoPercent: r.total_count > 0 ? (r.rto_count / r.total_count) * 100 : 0,
        cancellationPercent: r.total_count > 0 ? (r.cancelled_count / r.total_count) * 100 : 0,
        trend: [],
      })),
    );
  } catch (err) {
    next(err);
  }
});
```

`image` and `category` are always `""`, and `trend` (the 12-week sparkline) is always `[]` —
Shopify's Orders API doesn't return product images/categories or historical trend data;
that needs the Products API, which is out of scope for this pass. `rtoPercent` will always
be `0` today since no order ever gets a real `RTO Initiated`/`RTO Delivered` status yet
(courier integration is stubbed) — the query is still correct once that changes.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/shopify-data.ts server/test/routes/shopify-data.test.ts
git commit -m "feat(server): add GET /api/clients/:id/products real endpoint"
```

---

### Task 11: `GET /api/clients/:id/geography`

**Files:**
- Modify: `server/src/routes/shopify-data.ts` (append the route)
- Test: `server/test/routes/shopify-data.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/clients/:id/geography?level=state|city` → array matching `src/data/types.ts`'s `GeoRow` shape (`name, orders, sales, delivered, rto, rtoPercent, cancellationPercent, previousRtoPercent`). Task 12 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes/shopify-data.test.ts`:

```typescript
describe("GET /api/clients/:id/geography", () => {
  it("groups orders by state", async () => {
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid', 'Mumbai', 'Maharashtra'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Cancelled', 'COD', 'Pune', 'Maharashtra'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '3', 'Ravi Kumar', now(), 700, 'Delivered', 'Prepaid', 'Bengaluru', 'Karnataka')`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/geography?level=state")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const maharashtra = res.body.find((r: { name: string }) => r.name === "Maharashtra");
    expect(maharashtra).toMatchObject({ orders: 2, sales: 1500, cancellationPercent: 50 });
    const karnataka = res.body.find((r: { name: string }) => r.name === "Karnataka");
    expect(karnataka).toMatchObject({ orders: 1, sales: 700 });
  });

  it("groups orders by city when level=city", async () => {
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid', 'Mumbai', 'Maharashtra')`,
    );
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/geography?level=city")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("Mumbai");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test -- shopify-data.test.ts
```
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Append the route to `server/src/routes/shopify-data.ts`**

```typescript
router.get("/geography", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const level = req.query.level === "city" ? "city" : "state";

    const result = await pool.query(
      `select
         ${level} as name,
         count(*)::int as orders,
         sum(amount)::int as sales,
         count(*) filter (where status = 'Delivered')::int as delivered,
         count(*) filter (where status = 'RTO Initiated' or status = 'RTO Delivered')::int as rto,
         count(*) filter (where status = 'Cancelled')::int as cancelled,
         count(*)::int as total
       from shopify_orders
       where client_id = $1 and ${level} is not null
       group by ${level}
       order by sales desc`,
      [clientId],
    );

    res.json(
      result.rows.map((r) => ({
        name: r.name,
        orders: r.orders,
        sales: r.sales,
        delivered: r.delivered,
        rto: r.rto,
        rtoPercent: r.total > 0 ? (r.rto / r.total) * 100 : 0,
        cancellationPercent: r.total > 0 ? (r.cancelled / r.total) * 100 : 0,
        previousRtoPercent: 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});
```

`level` is interpolated directly into the query, but it's constrained to the literal
string `"state"` or `"city"` two lines above (never taken from user input beyond that
check) — not a SQL-injection path. `previousRtoPercent` (used for a trend arrow in the UI)
is always `0` — computing a real previous-period comparison needs a second date-ranged
query this endpoint doesn't take a `days` param for yet; deferred, not fabricated.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test npm test
```
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/shopify-data.ts server/test/routes/shopify-data.test.ts
git commit -m "feat(server): add GET /api/clients/:id/geography real endpoint"
```

---

### Task 12: Shared frontend fetch hook

**Files:**
- Create: `src/hooks/use-client-resource.ts`

**Interfaces:**
- Consumes: `session` from `useApp()` (`src/store/app-context.tsx`, already exists).
- Produces: `useClientResource<T>(path: string | null, fallback: T): { data: T; loading: boolean }`. Tasks 13 and 14 are the only consumers.

- [ ] **Step 1: Write the implementation**

This is a UI data-fetching hook with no meaningful unit to TDD against a real backend
(it's a thin `fetch` wrapper) — write it directly, then verify it through the pages that
use it in Tasks 13-14, exactly as `app-context.tsx`'s own fetch effect was verified.

```typescript
// src/hooks/use-client-resource.ts
import * as React from "react";
import { useApp } from "@/store/app-context";

interface SessionLike {
  access_token: string;
}

// Mirrors app-context.tsx's own session-aware fetch effect, generalized so every page
// in this plan doesn't repeat the same fetch/loading-state boilerplate. `path` is the
// full request path (e.g. "/api/clients/abc-fashion/orders?limit=40"); pass null to skip
// fetching (e.g. while the client id isn't known yet).
export function useClientResource<T>(path: string | null, fallback: T): { data: T; loading: boolean } {
  const [data, setData] = React.useState<T>(fallback);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!path) {
      setData(fallback);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const raw = localStorage.getItem(
      Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token")) ?? "",
    );
    const session: SessionLike | null = raw ? JSON.parse(raw) : null;
    if (!session) {
      setData(fallback);
      setLoading(false);
      return;
    }

    fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setData(fallback);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { data, loading };
}
```

This reads the Supabase session straight from `localStorage` rather than importing
`useApp()`'s internal session state, because `useApp()` doesn't expose the raw `Session`
object today (only `userEmail`/`authReady`) — adding that would touch `app-context.tsx`'s
public interface for every consumer, which is out of scope here. The `SessionLike`
type/localStorage-key lookup mirrors exactly what `app-context.tsx`'s own fetch effect
already does internally.

- [ ] **Step 2: Commit**

```bash
git add src/hooks/use-client-resource.ts
git commit -m "feat: add shared client-data fetch hook"
```

---

### Task 13: Rewire `usePeriodData` to real sales data

**Files:**
- Modify: `src/hooks/use-period-data.ts`

**Interfaces:**
- Consumes: `useClientResource` (Task 12), `GET /api/clients/:id/sales` (Task 8).
- Produces: same public shape as before (`{ days, current, previous, currentSum, previousSum }`) plus a new `loading` field — every existing consumer (Dashboard, Sales, Operations, Blended Marketing) keeps working unchanged; none of them read `loading` today, and none are required to.

- [ ] **Step 1: Replace the implementation**

```typescript
// src/hooks/use-period-data.ts
import * as React from "react";
import { useApp } from "@/store/app-context";
import { rangeToDays } from "@/lib/date-range";
import { getAllClientsSalesSeries, sumSeries } from "@/data/mock";
import { useClientResource } from "./use-client-resource";
import type { SalesPoint } from "@/data/types";

export function usePeriodData() {
  const { clientId, isAllClients, dateRange } = useApp();
  const days = rangeToDays(dateRange);

  const salesPath = !isAllClients && clientId ? `/api/clients/${clientId}/sales?days=${days * 2}` : null;
  const { data: realSeries, loading } = useClientResource<SalesPoint[]>(salesPath, []);

  return React.useMemo(() => {
    const total = isAllClients ? getAllClientsSalesSeries(days * 2) : realSeries;
    const current = total.slice(days);
    const previous = total.slice(0, days);
    return {
      days,
      current,
      previous,
      currentSum: sumSeries(current),
      previousSum: sumSeries(previous),
      loading,
    };
  }, [isAllClients, days, realSeries, loading]);
}

export function deriveMetrics(sum: ReturnType<typeof sumSeries>) {
  const aov = sum.orders > 0 ? sum.netSales / sum.orders : 0;
  const codPercent = sum.orders > 0 ? (sum.codOrders / sum.orders) * 100 : 0;
  const prepaidPercent = sum.orders > 0 ? (sum.prepaidOrders / sum.orders) * 100 : 0;
  const cancellationPercent = sum.orders > 0 ? (sum.cancelledOrders / sum.orders) * 100 : 0;
  const rtoPercent = sum.orders > 0 ? (sum.rtoOrders / sum.orders) * 100 : 0;
  const blendedRoas = sum.adSpend > 0 ? sum.netSales / sum.adSpend : 0;
  const costPerOrder = sum.orders > 0 ? sum.adSpend / sum.orders : 0;
  const blendedCac = sum.newCustomers > 0 ? sum.adSpend / sum.newCustomers : 0;

  return { aov, codPercent, prepaidPercent, cancellationPercent, rtoPercent, blendedRoas, costPerOrder, blendedCac };
}

export type { SalesPoint };
```

When `realSeries` is `[]` (still loading, or a client with nothing synced yet — no
Shopify connection, or connected but zero orders), `total.slice(days)`/`.slice(0, days)`
on an empty array both correctly return `[]`, and `sumSeries([])` correctly returns all
zeros (verify this against `sumSeries`'s existing implementation in `src/data/mock.ts` —
it's a plain `reduce` with a zeroed initial accumulator, so it does not throw on an empty
array). Every KPI card renders `0`/`₹0` rather than crashing — matching the same
fallback-over-crash principle already established for `mock.ts`'s `generateSalesSeries`.

- [ ] **Step 2: Verify manually in the browser**

Start both servers (`cd server && npm run dev`, then `npm run dev` at the repo root),
log in, and confirm the Dashboard renders without a console error for a client with real
synced Shopify orders (from Task 5's sync) and for a client with none (should show zeros,
not crash).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-period-data.ts
git commit -m "feat: wire usePeriodData to real sales data for single-client view"
```

---

### Task 14: Rewire Sales, Products, Geography, Operations pages

**Files:**
- Modify: `src/pages/sales.tsx`
- Modify: `src/pages/products.tsx`
- Modify: `src/pages/geography.tsx`
- Modify: `src/pages/operations.tsx`

**Interfaces:**
- Consumes: `useClientResource` (Task 12), `GET /api/clients/:id/orders`, `/products`, `/geography` (Tasks 9-11).
- Produces: nothing new — these are leaf consumers.

- [ ] **Step 1: `src/pages/sales.tsx`**

Replace:
```typescript
import { getOrders, getProducts } from "@/data/mock";
```
with:
```typescript
import { useClientResource } from "@/hooks/use-client-resource";
import type { Order, Product } from "@/data/types";
```

Replace:
```typescript
const orders = React.useMemo(() => getOrders(isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion", 40), [client, isAllClients]);
```
with:
```typescript
const ordersPath = !isAllClients && client ? `/api/clients/${client.id}/orders?limit=40` : null;
const { data: orders } = useClientResource<Order[]>(ordersPath, []);
```

Replace:
```typescript
const products = React.useMemo(() => getProducts(isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion"), [client, isAllClients]);
```
with:
```typescript
const productsPath = !isAllClients && client ? `/api/clients/${client.id}/products` : null;
const { data: products } = useClientResource<Product[]>(productsPath, []);
```

`isAllClients` mode still renders empty lists here rather than the old mock fallback —
this is a real, intentional gap: the All Clients aggregate view was never in this plan's
scope (mock.ts's own `getOrders`/`getProducts` never supported an aggregate mode either,
they were always being called with a hardcoded `"abc-fashion"` placeholder id in that
branch, which was already a pre-existing simplification, not a real aggregate).

- [ ] **Step 2: `src/pages/products.tsx`**

Replace:
```typescript
import { getProducts } from "@/data/mock";
```
with:
```typescript
import { useClientResource } from "@/hooks/use-client-resource";
import type { Product } from "@/data/types";
```

Replace:
```typescript
const products = React.useMemo(() => getProducts(cid), [cid]);
```
with:
```typescript
const { data: products } = useClientResource<Product[]>(cid ? `/api/clients/${cid}/products` : null, []);
```

- [ ] **Step 3: `src/pages/geography.tsx`**

Replace:
```typescript
import { getGeoBreakdown } from "@/data/mock";
```
with:
```typescript
import { useClientResource } from "@/hooks/use-client-resource";
import type { GeoRow } from "@/data/types";
```

Replace:
```typescript
const rows = React.useMemo(() => getGeoBreakdown(cid, level), [cid, level]);
```
with:
```typescript
const { data: rows } = useClientResource<GeoRow[]>(cid ? `/api/clients/${cid}/geography?level=${level}` : null, []);
```

- [ ] **Step 4: `src/pages/operations.tsx`**

Replace:
```typescript
import { getOrders, getGeoBreakdown, getCourierBreakdown } from "@/data/mock";
```
with:
```typescript
import { getCourierBreakdown } from "@/data/mock";
import { useClientResource } from "@/hooks/use-client-resource";
import type { Order, GeoRow } from "@/data/types";
```

Replace:
```typescript
const orders = React.useMemo(() => getOrders(cid, 200), [cid]);
```
with:
```typescript
const { data: orders } = useClientResource<Order[]>(cid ? `/api/clients/${cid}/orders?limit=200` : null, []);
```

Replace:
```typescript
const states = React.useMemo(() => getGeoBreakdown(cid, "state").slice(0, 8), [cid]);
```
with:
```typescript
const { data: statesRaw } = useClientResource<GeoRow[]>(cid ? `/api/clients/${cid}/geography?level=state` : null, []);
const states = statesRaw.slice(0, 8);
```

`getCourierBreakdown` stays exactly as it was — courier data is stubbed, not part of this
plan.

- [ ] **Step 5: Verify manually in the browser**

Log in, connect a client's Shopify store (Task 15 builds the UI for this — if that task
hasn't landed yet, insert a `platform_connections` row directly via SQL and run
`shopifyConnector.sync()` once by hand to seed real data), then visit Sales, Products,
Geography, and Operations and confirm each renders the real synced data with no console
errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/sales.tsx src/pages/products.tsx src/pages/geography.tsx src/pages/operations.tsx
git commit -m "feat: wire Sales/Products/Geography/Operations pages to real Shopify data"
```

---

### Task 15: Connect Shopify UI

**Files:**
- Modify: `src/pages/manage-clients.tsx`

**Interfaces:**
- Consumes: `useClientResource` (Task 12), `GET /api/clients/:id/connections` (existing), `POST /api/clients/:id/connections/shopify/authorize` (Task 4).
- Produces: nothing new — this is the final leaf consumer of the OAuth flow.

- [ ] **Step 1: Add the imports**

At the top of `src/pages/manage-clients.tsx`, add:
```typescript
import { useClientResource } from "@/hooks/use-client-resource";
```

- [ ] **Step 2: Replace the static integrations badge block in `ClientDetailDialog`**

Find this block (inside `ClientDetailDialog`, in the `col-span-2` div under "Connected
integrations"):

```tsx
<div className="col-span-2">
  <p className="mb-1.5 text-[10.5px] text-text-tertiary">Connected integrations</p>
  <div className="flex items-center gap-1.5">
    {client.integrations.map((i) => {
      const Icon = INTEGRATION_ICON[i];
      return (
        <span key={i} className="flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-[11px] font-medium capitalize text-text-secondary">
          <Icon className="size-3.5" />
          {i}
        </span>
      );
    })}
  </div>
</div>
```

Replace it with:

```tsx
<div className="col-span-2">
  <p className="mb-1.5 text-[10.5px] text-text-tertiary">Connected integrations</p>
  <ConnectionsPanel clientId={client.id} />
</div>
```

- [ ] **Step 3: Add the `ConnectionsPanel` component**

Add this new component to the file, near `ClientDetailDialog` (it's used only there for
now — Meta/Google's own connect buttons get added to this same component in their own
plans):

```tsx
interface Connection {
  platform: string;
  status: "connected" | "disconnected" | "error";
  externalAccountId: string;
}

function ConnectionsPanel({ clientId }: { clientId: string }) {
  const { data: connections, loading } = useClientResource<Connection[]>(`/api/clients/${clientId}/connections`, []);
  const [shopDomain, setShopDomain] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);

  const shopify = connections.find((c) => c.platform === "shopify");

  const handleConnect = async () => {
    if (!shopDomain.trim()) return;
    setConnecting(true);
    const raw = localStorage.getItem(
      Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token")) ?? "",
    );
    const session = raw ? JSON.parse(raw) : null;
    if (!session) {
      setConnecting(false);
      return;
    }
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${clientId}/connections/shopify/authorize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shopDomain: shopDomain.trim() }),
    });
    if (!res.ok) {
      setConnecting(false);
      return;
    }
    const { authorizeUrl } = await res.json();
    window.location.href = authorizeUrl;
  };

  if (loading) {
    return <p className="text-[11px] text-text-tertiary">Loading…</p>;
  }

  if (shopify && shopify.status === "connected") {
    return (
      <span className="flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-[11px] font-medium text-text-secondary">
        <ShoppingBag className="size-3.5" />
        Shopify — {shopify.externalAccountId}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={shopDomain}
        onChange={(e) => setShopDomain(e.target.value)}
        placeholder="yourstore.myshopify.com"
        className="h-7 max-w-52 text-[11px]"
      />
      <Button size="sm" onClick={handleConnect} disabled={connecting || !shopDomain.trim()}>
        Connect Shopify
      </Button>
    </div>
  );
}
```

`ShoppingBag` is already imported at the top of this file (used by the existing
`INTEGRATION_ICON` map).

- [ ] **Step 4: Verify manually against the real Shopify dev store**

This is the required manual end-to-end check for this whole plan — it cannot be
automated:

1. Start both servers with real `.env`/`.env.local` values (including real
   `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`, and `PUBLIC_API_URL`/`FRONTEND_URL` pointed at
   your actual dev URLs).
2. Register the OAuth redirect URI in your Shopify Partner app's settings:
   `{PUBLIC_API_URL}/api/integrations/shopify/callback`.
3. Log in, open Manage Clients, open a client's detail dialog, enter your real dev
   store's `*.myshopify.com` domain, click "Connect Shopify".
4. Confirm you land on Shopify's real OAuth consent screen, approve it, and land back on
   `/#/manage-clients?connection=success` with the dialog now showing "Shopify —
   yourstore.myshopify.com".
5. Manually trigger a sync (`POST /api/clients/:id/connections/shopify/sync` with a real
   bearer token, e.g. via `curl`), then confirm real orders appear in `shopify_orders`
   (direct SQL check) and on the Sales/Products/Geography/Operations pages.
6. Confirm the hourly scheduler picks up the connection on its own by checking
   `platform_connections.last_synced_at` again after the next hour boundary (or
   temporarily lower the cron schedule to `"* * * * *"` locally to verify it fires, then
   revert before committing).

- [ ] **Step 5: Commit**

```bash
git add src/pages/manage-clients.tsx
git commit -m "feat: add real Shopify connect UI to client detail dialog"
```

---

## What comes after this plan

The Meta Ads and Google Ads plans (per
`docs/superpowers/specs/2026-09-02-platform-integrations-design.md`) each add their own
connector to `server/src/lib/connector-registry.ts` — the dispatch routes, state-signing,
and scheduler built here are not touched again. They additionally introduce the
`campaigns`, `campaign_creatives`, and `campaign_notes` tables and wire the Meta Ads /
Google Ads pages the same way Task 14 wired Sales/Products/Geography/Operations here.
