# Integrations Framework (Plan 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every integration one connect/disconnect model (`oauth` or `credentials`), a single Integrations panel with one card per platform, and a forgiving Shopify store-name input, so plans 2–5 (Shiprocket, Delhivery, Meta Login for Business, Shopify install link) plug in without touching the framework.

**Architecture:** `Connector` becomes a discriminated union (`OAuthConnector | CredentialsConnector`). A new `POST /clients/:id/connections/:platform/connect` route (credentials platforms) and `DELETE /clients/:id/connections/:platform` route (disconnect) sit beside the existing OAuth `authorize`/`callback` routes, sharing one `saveConnection` helper. Migration 006 adds the `courier_shiprocket` platform value and an encrypted `credentials` column. On the frontend, three copy-pasted connect components collapse into `IntegrationCard` + `IntegrationsPanel`.

**Tech Stack:** Node/Express/TypeScript, `pg`, Vitest + Supertest (server); React 19 + Vite + Tailwind + Radix wrappers (frontend).

**Spec:** `docs/superpowers/specs/2026-09-27-simple-integrations-design.md` (plan 1 of its 5-plan rollout)

## Global Constraints

- Server tests need a real Postgres: run them as `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run <files>` (any local Postgres reachable via `TEST_DATABASE_URL` works; see `server/.env.example`). Server dependencies must be installed (`cd server && npm ci`).
- Server type-check command: `cd server && npx tsc --noEmit` (covers `server/src` only). Baseline is clean (exit 0); keep it clean.
- Frontend verification is `npm run build` (runs `tsc -b`; `noUnusedLocals`/`noUnusedParameters` are ON, so unused imports fail the build) and `npm run lint` (baseline has warnings only, none in files this plan creates; do not add new ones). The repo has **no frontend test runner and this plan does not add one**.
- Credentials/tokens are encrypted with `encryptToken`/`decryptToken` (`server/src/lib/crypto.ts`, key `CREDENTIAL_ENCRYPTION_KEY`) and are never returned by any endpoint or logged.
- Account-limit checks stay inside each connector (existing pattern); no new limit logic here.
- Errors use `HttpError(status, code, message)` (`server/src/lib/http-error.ts`) and the response body shape `{ error: { code, message } }`.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Frontend calls the API through `import.meta.env.VITE_API_URL` with a Supabase session bearer token.

---

### Task 1: Migration 006 — `courier_shiprocket` platform + `credentials` column

**Files:**
- Create: `server/migrations/006_courier_shiprocket_and_credentials.sql`
- Create: `server/test/migration-006.test.ts`

**Interfaces:**
- Produces: `platform_connections.platform` accepts `'courier_shiprocket'`; nullable `platform_connections.credentials text` column (encrypted JSON blob). Tasks 5 and plan 2 rely on both.

- [ ] **Step 1: Write the failing test**

Create `server/test/migration-006.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
});

describe("migration 006", () => {
  it("allows courier_shiprocket as a platform", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com')`,
    );
    const res = await testPool.query("select platform from platform_connections");
    expect(res.rows[0].platform).toBe("courier_shiprocket");
  });

  it("still rejects unknown platforms", async () => {
    await expect(
      testPool.query(
        `insert into platform_connections (client_id, platform, status, external_account_id)
         values ('abc-fashion', 'not_a_platform', 'connected', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it("has a nullable credentials column", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id, credentials)
       values ('abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com', 'enc-blob')`,
    );
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('abc-fashion', 'courier_delhivery', 'connected', 'token-fp')`,
    );
    const res = await testPool.query("select platform, credentials from platform_connections order by platform");
    expect(res.rows).toEqual([
      { platform: "courier_delhivery", credentials: null },
      { platform: "courier_shiprocket", credentials: "enc-blob" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-006.test.ts`
Expected: FAIL (the `courier_shiprocket` insert violates `platform_connections_platform_check`; `credentials` column does not exist).

- [ ] **Step 3: Write the migration**

Create `server/migrations/006_courier_shiprocket_and_credentials.sql`:

```sql
alter table platform_connections drop constraint platform_connections_platform_check;
alter table platform_connections add constraint platform_connections_platform_check
  check (platform in ('shopify', 'meta', 'google', 'courier_delhivery', 'courier_shadowfax', 'courier_shiprocket'));

-- AES-256-GCM encrypted JSON blob (via encryptToken). Holds secrets a connector needs to
-- re-authenticate later, e.g. Shiprocket's email + password. Null for token-only platforms.
alter table platform_connections add column credentials text;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-006.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/migrations/006_courier_shiprocket_and_credentials.sql server/test/migration-006.test.ts
git commit -m "$(cat <<'EOF'
feat(server): allow courier_shiprocket platform and add encrypted credentials column

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `Connector` discriminated union, `authType` guards, fake-courier test helper

**Files:**
- Modify: `server/src/integrations/types.ts`
- Modify: `server/src/integrations/shopify.ts` (connector declaration only)
- Modify: `server/src/integrations/meta.ts` (connector declaration only)
- Modify: `server/src/integrations/google.ts` (connector declaration only)
- Modify: `server/src/lib/connector-registry.ts`
- Modify: `server/src/routes/connections.ts` (authorize handler)
- Modify: `server/src/routes/integrations.ts` (callback handler)
- Create: `server/test/helpers/fake-courier.ts`
- Create: `server/test/routes/connections-framework.test.ts`

**Interfaces:**
- Produces (in `server/src/integrations/types.ts`):
  ```ts
  export class CredentialsRejectedError extends Error {}
  interface BaseConnector { platform: string; sync(connectionId: string): Promise<{ recordsSynced: number }>; disconnect(connectionId: string): Promise<void>; }
  export interface OAuthConnector extends BaseConnector { authType: "oauth"; getAuthUrl(clientId: string, state: string): string; handleCallback(query: Record<string, string>, context: { clientId: string }): Promise<{ externalAccountId: string; accessToken: string; refreshToken?: string; expiresAt?: Date }>; }
  export interface CredentialsConnector extends BaseConnector { authType: "credentials"; connectWithCredentials(clientId: string, credentials: Record<string, string>): Promise<{ externalAccountId: string; accessToken: string; expiresAt?: Date; credentials?: Record<string, string> }>; }
  export type Connector = OAuthConnector | CredentialsConnector;
  ```
- Produces (`server/test/helpers/fake-courier.ts`): `FAKE_COURIER_PLATFORM: "courier_shiprocket"` and `installFakeCourier(overrides?: Partial<CredentialsConnector>): () => void` (registers a fake credentials connector under that platform key and returns a restore function). Tasks 5 relies on these.
- `connectors` (`server/src/lib/connector-registry.ts`) is typed `Record<string, Connector>`. The shopify/meta/google exports are typed `OAuthConnector` so existing direct calls in their tests still type-check.

- [ ] **Step 1: Write the failing test**

Create `server/test/helpers/fake-courier.ts`:

```ts
import pool from "../../src/db.js";
import { connectors } from "../../src/lib/connector-registry.js";
import type { CredentialsConnector } from "../../src/integrations/types.js";

export const FAKE_COURIER_PLATFORM = "courier_shiprocket";

// Registers a fake credentials-type connector under a platform key that the DB check
// constraint allows, and returns a function that restores the registry. Use in
// beforeEach/afterEach so tests never leak a fake into each other.
export function installFakeCourier(overrides: Partial<CredentialsConnector> = {}): () => void {
  const original = connectors[FAKE_COURIER_PLATFORM];
  const fake: CredentialsConnector = {
    platform: FAKE_COURIER_PLATFORM,
    authType: "credentials",
    async connectWithCredentials(_clientId, credentials) {
      return { externalAccountId: credentials.email, accessToken: "fake-token", credentials };
    },
    async sync() {
      return { recordsSynced: 0 };
    },
    async disconnect(connectionId) {
      await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
    },
    ...overrides,
  };
  connectors[FAKE_COURIER_PLATFORM] = fake;
  return () => {
    if (original) connectors[FAKE_COURIER_PLATFORM] = original;
    else delete connectors[FAKE_COURIER_PLATFORM];
  };
}
```

Create `server/test/routes/connections-framework.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { installFakeCourier, FAKE_COURIER_PLATFORM } from "../helpers/fake-courier.js";
import { signState } from "../../src/lib/state-token.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
let restoreFakeCourier: () => void;

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  process.env.FRONTEND_URL = "https://d2c.probild.in";
  restoreFakeCourier = installFakeCourier();
});

afterEach(() => {
  restoreFakeCourier();
});

describe("authType guards", () => {
  it("rejects /authorize for a credentials-type platform", async () => {
    const token = signTestJwt({ sub: RIYA, email: "riya@agency.com" });
    const res = await request(app)
      .post(`/api/clients/abc-fashion/connections/${FAKE_COURIER_PLATFORM}/authorize`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("wrong_auth_type");
  });

  it("rejects the OAuth callback for a credentials-type platform", async () => {
    const state = await signState({ clientId: "abc-fashion", platform: FAKE_COURIER_PLATFORM, teamMemberId: RIYA });
    const res = await request(app)
      .get(`/api/integrations/${FAKE_COURIER_PLATFORM}/callback`)
      .query({ state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connections-framework.test.ts`
Expected: FAIL (the helper's `CredentialsConnector` type doesn't exist yet; at runtime the authorize call reaches `getAuthUrl` on the fake and throws a 500, and the callback route crashes into the catch and redirects with a different error, so the first test fails on `wrong_auth_type`).

- [ ] **Step 3: Replace the connector types**

Replace the whole contents of `server/src/integrations/types.ts` with:

```ts
// Thrown by a credentials connector when the provider says the credentials are wrong.
// The message is shown to the end user, so keep it human-readable and free of secrets.
export class CredentialsRejectedError extends Error {}

interface BaseConnector {
  platform: string;
  sync(connectionId: string): Promise<{ recordsSynced: number }>;
  disconnect(connectionId: string): Promise<void>;
}

// Connects by redirecting the user to the provider and handling the callback.
export interface OAuthConnector extends BaseConnector {
  authType: "oauth";
  getAuthUrl(clientId: string, state: string): string;
  handleCallback(query: Record<string, string>, context: { clientId: string }): Promise<{
    externalAccountId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;
}

// Connects from a form: the connector validates the credentials live against the provider.
export interface CredentialsConnector extends BaseConnector {
  authType: "credentials";
  connectWithCredentials(
    clientId: string,
    credentials: Record<string, string>,
  ): Promise<{
    externalAccountId: string;
    accessToken: string;
    expiresAt?: Date;
    // Secrets the connector needs later (e.g. Shiprocket email + password for re-login).
    // The route stores them encrypted in platform_connections.credentials.
    credentials?: Record<string, string>;
  }>;
}

export type Connector = OAuthConnector | CredentialsConnector;
```

- [ ] **Step 4: Tag the three existing connectors as OAuth**

In each of `shopify.ts`, `meta.ts`, `google.ts`:

1. Change the type import `import type { Connector } from "./types.js";` to `import type { OAuthConnector } from "./types.js";`
2. Change the declaration line: `export const shopifyConnector: Connector = {` → `export const shopifyConnector: OAuthConnector = {` (same for `metaConnector`, `googleConnector`).
3. Add `authType: "oauth",` as the line directly after the existing `platform: "...",` line in each object.

- [ ] **Step 5: Update the registry type**

In `server/src/lib/connector-registry.ts` the file already has `import type { Connector } from "../integrations/types.js";` and `Record<string, Connector>`; no text change is needed there. Confirm with `cd server && npx tsc --noEmit` at step 8 (it will flag every call site that still assumes OAuth methods exist).

- [ ] **Step 6: Guard the authorize route**

In `server/src/routes/connections.ts`, inside the `/:platform/authorize` handler, directly after the block

```ts
    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }
```

add:

```ts
    if (connector.authType !== "oauth") {
      throw new HttpError(400, "wrong_auth_type", `${platform} connects with credentials, not OAuth`);
    }
```

- [ ] **Step 7: Guard the callback route**

In `server/src/routes/integrations.ts`, replace

```ts
  const connector = connectors[platform];
  if (!connector) {
    redirectError("Unknown platform");
    return;
  }
```

with

```ts
  const connector = connectors[platform];
  if (!connector) {
    redirectError("Unknown platform");
    return;
  }
  if (connector.authType !== "oauth") {
    redirectError("This platform does not use OAuth");
    return;
  }
```

- [ ] **Step 8: Type-check and run tests**

Run: `cd server && npx tsc --noEmit`
Expected: no output (exit 0).

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connections-framework.test.ts test/routes/connections.test.ts test/routes/integrations.test.ts test/routes/sync.test.ts test/scheduler.test.ts`
Expected: all PASS (new tests plus the existing ones unchanged).

- [ ] **Step 9: Commit**

```bash
git add server/src server/test/helpers/fake-courier.ts server/test/routes/connections-framework.test.ts
git commit -m "$(cat <<'EOF'
feat(server): split Connector into OAuth and credentials variants

Adds authType discriminator, CredentialsRejectedError, authType guards on the
authorize and callback routes, and a fake-courier test helper.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Forgiving Shopify store-name input (server-side normalizer)

**Files:**
- Create: `server/src/lib/shop-domain.ts`
- Create: `server/test/lib/shop-domain.test.ts`
- Modify: `server/src/routes/connections.ts` (authorize handler, the Shopify domain block)
- Modify: `server/test/routes/connections.test.ts` (add cases)

**Interfaces:**
- Produces: `normalizeShopDomain(input: string): string | null` in `server/src/lib/shop-domain.ts`. Returns `"<handle>.myshopify.com"` or `null` if the input is not recognizably a Shopify store.
- Consumes: the `POST /api/clients/:id/connections/shopify/authorize` handler from `connections.ts`.

- [ ] **Step 1: Write the failing unit test**

Create `server/test/lib/shop-domain.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeShopDomain } from "../../src/lib/shop-domain.js";

describe("normalizeShopDomain", () => {
  it.each([
    ["mystore", "mystore.myshopify.com"],
    ["MyStore", "mystore.myshopify.com"],
    ["  mystore  ", "mystore.myshopify.com"],
    ["my-store-2", "my-store-2.myshopify.com"],
    ["mystore.myshopify.com", "mystore.myshopify.com"],
    ["MyStore.MyShopify.com", "mystore.myshopify.com"],
    ["https://mystore.myshopify.com", "mystore.myshopify.com"],
    ["https://mystore.myshopify.com/admin/products", "mystore.myshopify.com"],
    ["mystore.myshopify.com/admin", "mystore.myshopify.com"],
    ["admin.shopify.com/store/mystore", "mystore.myshopify.com"],
    ["https://admin.shopify.com/store/mystore/products?x=1", "mystore.myshopify.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeShopDomain(input)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["my store"],
    ["https://evil.example.com"],
    ["evil.com/mystore.myshopify.com"],
    ["mystore.myshopify.com.evil.com"],
    ["mystore.myshopify.com@evil.com"],
    ["-mystore"],
    ["shopify.com"],
  ])("rejects %j", (input) => {
    expect(normalizeShopDomain(input)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/shop-domain.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the normalizer**

Create `server/src/lib/shop-domain.ts`:

```ts
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const ADMIN_URL_RE = /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#].*)?$/;

// Turns whatever a user pasted (store name, myshopify domain, admin URL) into the canonical
// "<handle>.myshopify.com" form, or null if it isn't recognizably a Shopify store. The result
// is used as the OAuth host, so only the exact canonical shape is ever returned.
export function normalizeShopDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const adminMatch = raw.match(ADMIN_URL_RE);
  if (adminMatch) return `${adminMatch[1]}.myshopify.com`;

  if (HANDLE_RE.test(raw)) return `${raw}.myshopify.com`;

  let host: string;
  try {
    host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  return SHOP_DOMAIN_RE.test(host) ? host : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/shop-domain.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Write failing route tests**

In `server/test/routes/connections.test.ts`, inside `describe("POST /api/clients/:id/connections/:platform/authorize", ...)`, add these two tests after the existing `"400s for a shopDomain that isn't a valid *.myshopify.com domain"` test:

```ts
  it("accepts a bare store name and normalizes it", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({ shopDomain: "ABC-Fashion" });
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
  });

  it("accepts a pasted Shopify admin URL", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({ shopDomain: "https://admin.shopify.com/store/abc-fashion/orders" });
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
  });

  it("returns a friendly message for an unrecognizable store", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/authorize")
      .set("Authorization", `Bearer ${token}`)
      .send({ shopDomain: "not a store" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_shop_domain");
    expect(res.body.error.message).toContain("store name");
  });
```

- [ ] **Step 6: Run to verify the new route tests fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connections.test.ts`
Expected: the three new tests FAIL (bare name/admin URL are rejected by the old strict regex; message text differs).

- [ ] **Step 7: Use the normalizer in the authorize route**

In `server/src/routes/connections.ts` add the import next to the other lib imports:

```ts
import { normalizeShopDomain } from "../lib/shop-domain.js";
```

Then replace this block in the `/:platform/authorize` handler:

```ts
    const shopDomain = (req.body as { shopDomain?: string }).shopDomain;
    if (platform === "shopify" && !/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain ?? "")) {
      throw new HttpError(400, "invalid_shop_domain", "shopDomain must be a valid *.myshopify.com domain");
    }

    const state = await signState({
      clientId,
      platform,
      teamMemberId: req.auth!.userId,
      shopDomain: platform === "shopify" ? shopDomain : undefined,
    });
```

with:

```ts
    let shopDomain: string | undefined;
    if (platform === "shopify") {
      const rawShopDomain = (req.body as { shopDomain?: unknown }).shopDomain;
      const normalized = normalizeShopDomain(typeof rawShopDomain === "string" ? rawShopDomain : "");
      if (!normalized) {
        throw new HttpError(
          400,
          "invalid_shop_domain",
          "Enter your Shopify store name, like mystore or mystore.myshopify.com",
        );
      }
      shopDomain = normalized;
    }

    const state = await signState({
      clientId,
      platform,
      teamMemberId: req.auth!.userId,
      shopDomain,
    });
```

(The line `const authorizeUrl = connector.getAuthUrl(shopDomain ?? clientId, state);` below stays as is.)

- [ ] **Step 8: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/shop-domain.test.ts test/routes/connections.test.ts test/routes/integrations.test.ts`
Expected: all PASS, including the pre-existing `"400s for a shopDomain that isn't a valid *.myshopify.com domain"` (`https://evil.example.com` normalizes to null).

- [ ] **Step 9: Commit**

```bash
git add server/src/lib/shop-domain.ts server/src/routes/connections.ts server/test/lib/shop-domain.test.ts server/test/routes/connections.test.ts
git commit -m "$(cat <<'EOF'
feat(server): accept bare store names and admin URLs for Shopify connect

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Per-user rate limiter middleware

**Files:**
- Create: `server/src/middleware/rate-limit.ts`
- Create: `server/test/middleware/rate-limit.test.ts`

**Interfaces:**
- Produces: `createRateLimiter(options: { max: number; windowMs: number; now?: () => number }): (req: Request, res: Response, next: NextFunction) => void`. Keyed by `req.auth.userId` + `req.params.id`. Calls `next(new HttpError(429, "rate_limited", ...))` once `max` requests were seen within `windowMs`. Must run after `requireAuth`. Task 5 consumes it.

- [ ] **Step 1: Write the failing test**

Create `server/test/middleware/rate-limit.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { createRateLimiter } from "../../src/middleware/rate-limit.js";
import { HttpError } from "../../src/lib/http-error.js";

function fakeReq(userId: string, clientId: string): Request {
  return { auth: { userId, email: "x@y.z" }, params: { id: clientId } } as unknown as Request;
}

const res = {} as Response;

describe("createRateLimiter", () => {
  it("allows up to max requests then returns a 429 HttpError", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u1", "c1"), res, next);
    expect(next).toHaveBeenNthCalledWith(1);
    expect(next).toHaveBeenNthCalledWith(2);
    const third = next.mock.calls[2][0];
    expect(third).toBeInstanceOf(HttpError);
    expect(third.status).toBe(429);
    expect(third.code).toBe("rate_limited");
  });

  it("tracks users and clients independently", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u2", "c1"), res, next);
    limiter(fakeReq("u1", "c2"), res, next);
    expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
  });

  it("forgets attempts once the window has passed", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    t = 1001;
    limiter(fakeReq("u1", "c1"), res, next);
    expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/middleware/rate-limit.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `server/src/middleware/rate-limit.ts`:

```ts
import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";

// In-memory sliding-window limiter. The API runs as a single process, so a per-process map
// is enough; it exists to blunt credential-guessing through the connect endpoint, not to be
// a general-purpose quota system. Must be mounted after requireAuth so req.auth is set.
export function createRateLimiter({
  max,
  windowMs,
  now = Date.now,
}: {
  max: number;
  windowMs: number;
  now?: () => number;
}) {
  const hits = new Map<string, number[]>();

  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${req.auth?.userId ?? "anon"}:${req.params.id ?? ""}`;
    const t = now();
    const recent = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      next(new HttpError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again."));
      return;
    }
    recent.push(t);
    hits.set(key, recent);
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/middleware/rate-limit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/rate-limit.ts server/test/middleware/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add per-user in-memory rate limiter middleware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `saveConnection` helper, credentials `/connect` route, `DELETE` disconnect route

**Files:**
- Create: `server/src/lib/connection-store.ts`
- Modify: `server/src/routes/integrations.ts` (callback uses `saveConnection`)
- Modify: `server/src/routes/connections.ts` (add `/connect` and `DELETE`)
- Modify: `server/test/routes/connections-framework.test.ts` (add describes)
- Create: `server/test/routes/connect-rate-limit.test.ts`

**Interfaces:**
- Consumes: `CredentialsRejectedError`, `CredentialsConnector` (Task 2); `createRateLimiter` (Task 4); `installFakeCourier`, `FAKE_COURIER_PLATFORM` (Task 2); `platform_connections.credentials` (Task 1).
- Produces:
  ```ts
  // server/src/lib/connection-store.ts
  export interface SaveConnectionInput { clientId: string; platform: string; externalAccountId: string; accessToken: string; refreshToken?: string; expiresAt?: Date; credentials?: Record<string, string>; connectedBy: string; }
  export async function saveConnection(input: SaveConnectionInput): Promise<void>;
  ```
- Produces HTTP:
  - `POST /api/clients/:id/connections/:platform/connect` body `{ credentials: Record<string,string> }` → 200 `{ platform, status: "connected", externalAccountId }`. Errors: 404 `unknown_platform`, 400 `wrong_auth_type`, 400 `invalid_credentials_payload`, 400 `credentials_rejected` (from `CredentialsRejectedError`), 502 `provider_unreachable` (anything else), 429 `rate_limited` (10 per 10 min per user+client).
  - `DELETE /api/clients/:id/connections/:platform` → 204; 404 `unknown_platform` / `not_connected`. Disconnects every non-disconnected connection of that platform for the client via the connector's `disconnect`; history is kept.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/routes/connections-framework.test.ts` (add `decryptToken` and `CredentialsRejectedError` imports at the top: `import { decryptToken } from "../../src/lib/crypto.js";` and `import { CredentialsRejectedError } from "../../src/integrations/types.js";`), and append these describes at the end of the file:

```ts
const CREDS = { email: "ops@abc.com", password: "hunter2-secret" };

describe("POST /api/clients/:id/connections/:platform/connect", () => {
  const post = (platform: string, body: unknown, sub = RIYA, email = "riya@agency.com") =>
    request(app)
      .post(`/api/clients/abc-fashion/connections/${platform}/connect`)
      .set("Authorization", `Bearer ${signTestJwt({ sub, email })}`)
      .send(body as object);

  it("connects with valid credentials and stores them encrypted", async () => {
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      platform: FAKE_COURIER_PLATFORM,
      status: "connected",
      externalAccountId: "ops@abc.com",
    });

    const row = (await testPool.query("select access_token, credentials, status, connected_by from platform_connections")).rows[0];
    expect(row.status).toBe("connected");
    expect(row.connected_by).toBe(RIYA);
    expect(decryptToken(row.access_token)).toBe("fake-token");
    expect(row.credentials).not.toContain("hunter2-secret");
    expect(JSON.parse(decryptToken(row.credentials))).toEqual(CREDS);
  });

  it("never returns secrets from the connections list", async () => {
    await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    const list = await request(app)
      .get("/api/clients/abc-fashion/connections")
      .set("Authorization", `Bearer ${signTestJwt({ sub: RIYA, email: "riya@agency.com" })}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("hunter2-secret");
    expect(JSON.stringify(list.body)).not.toContain("fake-token");
  });

  it("404s for an unknown platform", async () => {
    const res = await post("not_a_platform", { credentials: CREDS });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_platform");
  });

  it("400s for an OAuth-type platform", async () => {
    const res = await post("shopify", { credentials: CREDS });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("wrong_auth_type");
  });

  it("400s when credentials is missing or not a string map", async () => {
    const missing = await post(FAKE_COURIER_PLATFORM, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_credentials_payload");
    const wrongShape = await post(FAKE_COURIER_PLATFORM, { credentials: { email: 42 } });
    expect(wrongShape.status).toBe(400);
    expect(wrongShape.body.error.code).toBe("invalid_credentials_payload");
  });

  it("returns the provider's message as a 400 and creates no connection when credentials are rejected", async () => {
    restoreFakeCourier();
    restoreFakeCourier = installFakeCourier({
      async connectWithCredentials() {
        throw new CredentialsRejectedError("Shiprocket rejected these credentials");
      },
    });
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "credentials_rejected", message: "Shiprocket rejected these credentials" });
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("returns a generic 502 without leaking internals on unexpected failures", async () => {
    restoreFakeCourier();
    restoreFakeCourier = installFakeCourier({
      async connectWithCredentials() {
        throw new Error("connect ECONNREFUSED 10.0.0.5:443 secret-internal-detail");
      },
    });
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("provider_unreachable");
    expect(JSON.stringify(res.body)).not.toContain("secret-internal-detail");
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS }, "22222222-2222-2222-2222-222222222222", "scoped@agency.com");
    expect(res.status).toBe(404);
  });

  it("reconnecting the same account updates the row instead of duplicating it", async () => {
    await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(1);
  });
});

describe("DELETE /api/clients/:id/connections/:platform", () => {
  const del = (platform: string, sub = RIYA, email = "riya@agency.com") =>
    request(app)
      .delete(`/api/clients/abc-fashion/connections/${platform}`)
      .set("Authorization", `Bearer ${signTestJwt({ sub, email })}`);

  beforeEach(async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id) values
       ('abc-fashion', '${FAKE_COURIER_PLATFORM}', 'connected', 'ops@abc.com')`,
    );
  });

  it("disconnects the platform for the client and keeps the row", async () => {
    const res = await del(FAKE_COURIER_PLATFORM);
    expect(res.status).toBe(204);
    const rows = (await testPool.query("select status from platform_connections")).rows;
    expect(rows).toEqual([{ status: "disconnected" }]);
  });

  it("404s not_connected when there is nothing to disconnect", async () => {
    await del(FAKE_COURIER_PLATFORM);
    const again = await del(FAKE_COURIER_PLATFORM);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("not_connected");
  });

  it("404s for an unknown platform", async () => {
    const res = await del("not_a_platform");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_platform");
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const res = await del(FAKE_COURIER_PLATFORM, "22222222-2222-2222-2222-222222222222", "scoped@agency.com");
    expect(res.status).toBe(404);
  });
});
```

Create `server/test/routes/connect-rate-limit.test.ts` (its own file so the limiter's module-level state starts fresh):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { installFakeCourier, FAKE_COURIER_PLATFORM } from "../helpers/fake-courier.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
let restore: () => void;

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  restore = installFakeCourier();
});

afterEach(() => restore());

describe("connect rate limiting", () => {
  it("returns 429 after 10 attempts in the window", async () => {
    const token = signTestJwt({ sub: RIYA, email: "riya@agency.com" });
    const attempt = () =>
      request(app)
        .post(`/api/clients/abc-fashion/connections/${FAKE_COURIER_PLATFORM}/connect`)
        .set("Authorization", `Bearer ${token}`)
        .send({ credentials: { email: "ops@abc.com", password: "x" } });

    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status).toBe(200);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connections-framework.test.ts test/routes/connect-rate-limit.test.ts`
Expected: the new `/connect`, `DELETE` and rate-limit tests FAIL (404 for the missing routes); the two Task 2 guard tests still pass.

- [ ] **Step 3: Create the shared save helper**

Create `server/src/lib/connection-store.ts`:

```ts
import pool from "../db.js";
import { encryptToken } from "./crypto.js";

export interface SaveConnectionInput {
  clientId: string;
  platform: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  // Encrypted as one JSON blob into platform_connections.credentials.
  credentials?: Record<string, string>;
  connectedBy: string;
}

// The one place a successful connect (OAuth callback or credentials form) is persisted.
// Reconnecting the same external account updates the existing row instead of duplicating it.
export async function saveConnection(input: SaveConnectionInput): Promise<void> {
  await pool.query(
    `insert into platform_connections
       (client_id, platform, status, access_token, refresh_token, token_expires_at, external_account_id, credentials, connected_by)
     values ($1, $2, 'connected', $3, $4, $5, $6, $7, $8)
     on conflict (client_id, platform, external_account_id)
     do update set status = 'connected', access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at,
       credentials = excluded.credentials`,
    [
      input.clientId,
      input.platform,
      encryptToken(input.accessToken),
      input.refreshToken ? encryptToken(input.refreshToken) : null,
      input.expiresAt ?? null,
      input.externalAccountId,
      input.credentials ? encryptToken(JSON.stringify(input.credentials)) : null,
      input.connectedBy,
    ],
  );
}
```

- [ ] **Step 4: Make the OAuth callback use it (behavior unchanged)**

In `server/src/routes/integrations.ts`:

1. Replace the imports `import pool from "../db.js";` and `import { encryptToken } from "../lib/crypto.js";` with `import { saveConnection } from "../lib/connection-store.js";` (the file no longer uses `pool` or `encryptToken` after step 2; `tsc` will confirm).
2. Replace the whole `await pool.query(...)` insert statement inside the `try` block (everything from `await pool.query(` through its closing `);`) with:

```ts
    await saveConnection({
      clientId: statePayload.clientId,
      platform,
      externalAccountId,
      accessToken,
      refreshToken,
      expiresAt,
      connectedBy: statePayload.teamMemberId,
    });
```

- [ ] **Step 5: Add the `/connect` and `DELETE` routes**

In `server/src/routes/connections.ts`, add imports next to the existing ones:

```ts
import { saveConnection } from "../lib/connection-store.js";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { CredentialsRejectedError } from "../integrations/types.js";
```

Then add below the `createRateLimiter` import area (after `const router = Router({ mergeParams: true });`):

```ts
// 10 attempts per user per client per 10 minutes: enough for typos, too few for guessing.
const connectLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
```

and add these two routes before `export default router;`:

```ts
router.post("/:platform/connect", requireAuth, connectLimiter, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }
    if (connector.authType !== "credentials") {
      throw new HttpError(400, "wrong_auth_type", `${platform} connects through a login redirect, not credentials`);
    }

    const credentials = (req.body as { credentials?: unknown }).credentials;
    if (!isStringMap(credentials)) {
      throw new HttpError(400, "invalid_credentials_payload", "credentials must be an object of text fields");
    }

    let result;
    try {
      result = await connector.connectWithCredentials(clientId, credentials);
    } catch (err) {
      if (err instanceof CredentialsRejectedError) {
        throw new HttpError(400, "credentials_rejected", err.message);
      }
      console.error(`Credential connect failed for ${platform}:`, err);
      throw new HttpError(
        502,
        "provider_unreachable",
        "Couldn't verify these credentials right now. Please try again in a moment.",
      );
    }

    await saveConnection({
      clientId,
      platform,
      externalAccountId: result.externalAccountId,
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      credentials: result.credentials,
      connectedBy: req.auth!.userId,
    });
    res.json({ platform, status: "connected", externalAccountId: result.externalAccountId });
  } catch (err) {
    next(err);
  }
});

router.delete("/:platform", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }

    const active = await pool.query(
      "select id from platform_connections where client_id = $1 and platform = $2 and status <> 'disconnected'",
      [clientId, platform],
    );
    if (active.rowCount === 0) {
      throw new HttpError(404, "not_connected", `No active ${platform} connection for this client`);
    }
    for (const row of active.rows) {
      await connector.disconnect(row.id);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Type-check and run the full affected test set**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connections-framework.test.ts test/routes/connect-rate-limit.test.ts test/routes/connections.test.ts test/routes/integrations.test.ts`
Expected: all PASS (`integrations.test.ts` passing unchanged proves the `saveConnection` refactor preserved callback behavior).

- [ ] **Step 7: Commit**

```bash
git add server/src server/test
git commit -m "$(cat <<'EOF'
feat(server): add credentials connect and disconnect routes

Shared saveConnection helper, POST /connections/:platform/connect with live
validation and rate limiting, DELETE /connections/:platform.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend API helper and platform metadata

**Files:**
- Create: `src/lib/api.ts`
- Create: `src/components/integrations/platforms.ts`

**Interfaces:**
- Produces (`src/lib/api.ts`): `class ApiError extends Error`; `apiFetch(path: string, init?: Omit<RequestInit, "headers">): Promise<Response>` — adds the Supabase bearer token and JSON content type, throws `ApiError` with a user-readable message on no session, network failure, or non-2xx (using the server's `error.message` when present).
- Produces (`src/components/integrations/platforms.ts`): 
  ```ts
  export interface Connection { platform: string; status: "connected" | "disconnected" | "error"; externalAccountId: string; lastSyncedAt: string | null; }
  export interface PlatformInput { placeholder: string; helper: string; bodyKey: string; }
  export interface PlatformMeta { key: string; label: string; description: string; icon: React.ElementType; input?: PlatformInput; }
  export const OAUTH_PLATFORMS: PlatformMeta[]; // shopify, meta, google
  ```
  Task 7 consumes these.

- [ ] **Step 1: Create the API helper**

Create `src/lib/api.ts`:

```ts
import { supabase } from "@/lib/supabase";

export class ApiError extends Error {}

// Authenticated call to the backend. Throws ApiError with a message that is safe to show
// to the user: the server's own error message when it sent one, otherwise a generic one.
export async function apiFetch(path: string, init: Omit<RequestInit, "headers"> = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new ApiError("You're not signed in. Please log in again.");
  }

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error?.message ?? `Request failed (${res.status}). Please try again.`);
  }
  return res;
}
```

- [ ] **Step 2: Create the platform metadata**

Create `src/components/integrations/platforms.ts`:

```ts
import type * as React from "react";
import { Megaphone, Search, ShoppingBag } from "lucide-react";

export interface Connection {
  platform: string;
  status: "connected" | "disconnected" | "error";
  externalAccountId: string;
  lastSyncedAt: string | null;
}

// Some OAuth platforms need one piece of input before the redirect (Shopify: which store).
export interface PlatformInput {
  placeholder: string;
  helper: string;
  // Field name the backend's /authorize endpoint expects in the JSON body.
  bodyKey: string;
}

export interface PlatformMeta {
  key: string;
  label: string;
  description: string;
  icon: React.ElementType;
  input?: PlatformInput;
}

export const OAUTH_PLATFORMS: PlatformMeta[] = [
  {
    key: "shopify",
    label: "Shopify",
    description: "Orders, products and customers from the store",
    icon: ShoppingBag,
    input: {
      placeholder: "yourstore",
      helper: "Just the store name is fine, e.g. mystore. Pasting the admin URL works too.",
      bodyKey: "shopDomain",
    },
  },
  {
    key: "meta",
    label: "Meta Ads",
    description: "Campaigns and creatives from Meta Business Manager",
    icon: Megaphone,
  },
  {
    key: "google",
    label: "Google Ads",
    description: "Campaigns and performance from Google Ads",
    icon: Search,
  },
];
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: succeeds (the new files are not imported yet; this only proves they type-check, since `tsc -b` covers `src`). Ignore the pre-existing chunk-size warning.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/components/integrations/platforms.ts
git commit -m "$(cat <<'EOF'
feat: add authenticated apiFetch helper and integration platform metadata

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `IntegrationCard` + `IntegrationsPanel`, replace the copy-pasted connect components

**Files:**
- Create: `src/components/integrations/integration-card.tsx`
- Create: `src/components/integrations/integrations-panel.tsx`
- Modify: `src/pages/manage-clients.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError` (Task 6); `Connection`, `PlatformMeta`, `OAUTH_PLATFORMS` (Task 6); `useClientResource` (`src/hooks/use-client-resource.ts`); backend routes from Tasks 3 and 5 (`POST .../authorize` with `{ shopDomain }` for Shopify, `DELETE .../connections/:platform`).
- Produces: `<IntegrationsPanel clientId={string} />` (default replacement for `ConnectionsPanel`); `pickConnection(connections: Connection[], platform: string): Connection | undefined` exported from `integration-card.tsx`.

- [ ] **Step 1: Create the card**

Create `src/components/integrations/integration-card.tsx`:

```tsx
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import type { Connection, PlatformMeta } from "./platforms";

const STATUS_BADGE = {
  connected: { label: "Connected", variant: "positive" },
  error: { label: "Needs attention", variant: "warning" },
  disconnected: { label: "Not connected", variant: "neutral" },
} as const;

// A client can have several rows per platform over time (reconnects, old disconnects).
// Show the live one; otherwise the broken one; otherwise the most recent.
export function pickConnection(connections: Connection[], platform: string): Connection | undefined {
  const forPlatform = connections.filter((c) => c.platform === platform);
  return (
    forPlatform.find((c) => c.status === "connected") ??
    forPlatform.find((c) => c.status === "error") ??
    forPlatform[forPlatform.length - 1]
  );
}

export function IntegrationCard({
  platform,
  connection,
  clientId,
  onChanged,
}: {
  platform: PlatformMeta;
  connection: Connection | undefined;
  clientId: string;
  onChanged: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const Icon = platform.icon;
  const status = connection?.status ?? "disconnected";
  const badge = STATUS_BADGE[status];
  const isConnected = status === "connected";
  const needsInput = Boolean(platform.input) && !isConnected;
  const canConnect = !busy && (!needsInput || value.trim().length > 0);

  const connect = async () => {
    if (!canConnect) return;
    setBusy(true);
    setError(null);
    try {
      const body = platform.input ? { [platform.input.bodyKey]: value.trim() } : {};
      const res = await apiFetch(`/api/clients/${clientId}/connections/${platform.key}/authorize`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      // Full-page redirect to the provider's login; the backend callback brings the user back.
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to connect ${platform.label}. Please try again.`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/clients/${clientId}/connections/${platform.key}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to disconnect ${platform.label}. Please try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-text-secondary">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12.5px] font-medium text-text-primary">{platform.label}</p>
            <Badge variant={badge.variant} dot>
              {badge.label}
            </Badge>
          </div>
          <p className="text-[11px] text-text-tertiary">{platform.description}</p>
          {connection && isConnected && (
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">
              {connection.externalAccountId}
              {connection.lastSyncedAt
                ? ` · synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                : " · first sync pending"}
            </p>
          )}
          {status === "error" && <p className="mt-0.5 text-[11px] text-warning">The last sync failed. Reconnect to fix it.</p>}
        </div>
      </div>

      {needsInput && platform.input && (
        <div>
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") connect();
            }}
            placeholder={platform.input.placeholder}
            aria-label={`${platform.label} ${platform.input.placeholder}`}
            className="h-8 text-[12px]"
          />
          <p className="mt-1 text-[11px] text-text-tertiary">{platform.input.helper}</p>
        </div>
      )}

      {error && <p className="text-[11px] text-negative">{error}</p>}

      <div className="flex justify-end">
        {isConnected ? (
          <Button size="sm" variant="ghost" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={!canConnect}>
            {status === "error" ? "Reconnect" : "Connect"}
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the panel**

Create `src/components/integrations/integrations-panel.tsx`:

```tsx
import * as React from "react";
import { useClientResource } from "@/hooks/use-client-resource";
import { IntegrationCard, pickConnection } from "./integration-card";
import { OAUTH_PLATFORMS, type Connection } from "./platforms";

const EMPTY_CONNECTIONS: Connection[] = [];

export function IntegrationsPanel({ clientId }: { clientId: string }) {
  // useClientResource refetches when its path changes; bumping this throwaway query param
  // after a disconnect forces a reload (the server ignores unknown query params).
  const [version, setVersion] = React.useState(0);
  const { data: connections, loading } = useClientResource<Connection[]>(
    `/api/clients/${clientId}/connections?v=${version}`,
    EMPTY_CONNECTIONS,
  );

  if (loading && connections.length === 0) {
    return <p className="text-[11px] text-text-tertiary">Loading…</p>;
  }

  return (
    <div className="space-y-2">
      {OAUTH_PLATFORMS.map((platform) => (
        <IntegrationCard
          key={platform.key}
          platform={platform}
          connection={pickConnection(connections, platform.key)}
          clientId={clientId}
          onChanged={() => setVersion((v) => v + 1)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Swap it into `manage-clients.tsx`**

In `src/pages/manage-clients.tsx`:

1. Add the import next to the other component imports: `import { IntegrationsPanel } from "@/components/integrations/integrations-panel";`
2. Delete the `interface Connection { ... }`, `const EMPTY_CONNECTIONS ...`, the whole `function MetaConnectButton(...)`, the whole `function GoogleConnectButton(...)`, and the whole `function ConnectionsPanel(...)` (from `interface Connection {` through the closing brace of `ConnectionsPanel`; keep `const EMPTY_TEAM` and everything from `type ConnectionResult` onward).
3. Replace the single usage `<ConnectionsPanel clientId={client.id} />` with `<IntegrationsPanel clientId={client.id} />`.
4. In `ConnectionResultBanner`, change the success text `"Shopify connected successfully."` to `"Connected successfully."` (the OAuth callback redirect does not say which platform).
5. Run `npm run build`. `noUnusedLocals` will now report imports that only the deleted code used. Delete exactly the imports the compiler reports as unused (likely candidates: `Input`, `supabase`, possibly `useClientResource` if nothing else uses it; keep any the file still uses, e.g. `Input` if `AddClientDialog` uses it). Re-run until it builds.

- [ ] **Step 4: Verify build and lint**

Run: `npm run build`
Expected: succeeds.

Run: `npm run lint`
Expected: no new warnings from `src/components/integrations/*`, `src/lib/api.ts`, or `src/pages/manage-clients.tsx` beyond the pre-existing `react(set-state-in-effect)` warning already reported at `manage-clients.tsx` (its line number will have shifted up).

- [ ] **Step 5: Manual verification**

Run the app (`npm run dev` in the repo root, and the API with `cd server && npm run dev` with a populated `server/.env`), sign in, open Manage Clients → open a client → check each state:

1. **Not connected**: three cards show a "Not connected" badge; Shopify shows a store input and a disabled Connect button until text is typed; Meta/Google show an enabled Connect button.
2. **Shopify input forms**: `mystore`, `mystore.myshopify.com`, and `https://admin.shopify.com/store/mystore` all redirect to `https://mystore.myshopify.com/admin/oauth/authorize?...`; pressing Enter in the input submits; `not a store` shows the inline "Enter your Shopify store name…" error and stays on the page.
3. **Connected** (after completing a real connect): badge "Connected", account id and last-synced text shown, "Disconnect" button; clicking it flips the card to "Not connected" without a full page reload.
4. **Error**: set a connection's `status` to `error` in the DB; the card shows "Needs attention", the warning line, and a "Reconnect" button.
5. **Return banner**: after an OAuth round trip the banner reads "Connected successfully." (or the server's error message) and dismisses.

Record what you checked in the commit body. If a real Shopify/Meta/Google account isn't available, say so explicitly rather than claiming those states were verified.

- [ ] **Step 6: Commit**

```bash
git add src/components/integrations src/pages/manage-clients.tsx
git commit -m "$(cat <<'EOF'
feat: replace per-platform connect buttons with IntegrationCard panel

One card per platform with status, connect/reconnect and disconnect. Removes the
three copy-pasted connect components from manage-clients.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Final verification and graph refresh

**Files:**
- Modify: `docs/superpowers/plans/2026-09-27-integrations-framework.md` (tick boxes only, optional)

- [ ] **Step 1: Run the whole server suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: type-check clean and every test file PASS (no regressions in Shopify/Meta/Google/sync/scheduler suites).

- [ ] **Step 2: Run frontend checks**

Run: `npm run build && npm run lint`
Expected: build succeeds; lint shows only the pre-existing warnings.

- [ ] **Step 3: Confirm nothing sensitive leaks**

Run: `git grep -n "hunter2-secret\|fake-token" -- server/src src`
Expected: no matches (these strings exist only in tests).

- [ ] **Step 4: Refresh the knowledge graph**

Run: `graphify update .`
Expected: completes without error (AST-only, no API cost). Per the repo's CLAUDE.md, this keeps `graphify-out/` current after code changes. Commit only if `graphify-out/` files are tracked and changed:

```bash
git status --short graphify-out | head
```

If tracked files changed:

```bash
git add graphify-out
git commit -m "$(cat <<'EOF'
chore: refresh graphify graph after integrations framework

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Report**

Summarize for the user: what shipped, the test/build results with actual counts, which manual states in Task 7 step 5 were verified vs. not, and that plan 2 (Shiprocket + shipments + Operations, including the credentials dialog) is next.
