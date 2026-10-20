# Shopify App Store App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant browsing Shopify's App Store can install this app with one click and land inside the existing dashboard, fully provisioned (account, Shopify connection, billing) and already logged in — no password, no manual OAuth setup.

**Architecture:** A brand-new, separate Shopify Partner app (its own client ID/secret — the existing agency-connect flow's Shopify app is never touched) drives a self-contained install → provision → bill → auto-login pipeline, deliberately NOT reusing `shopifyConnector.handleCallback` (that function is live, production-critical infrastructure for the already-shipped agency-connect and install-link flows; a small, isolated duplication of its ~20-line HMAC-verify/token-exchange logic is lower risk than refactoring code three unrelated flows depend on). Provisioning mirrors the existing Razorpay self-serve signup's pay-then-provision transaction almost exactly (`server/src/routes/signup.ts`'s `/complete` handler), substituting a Shopify-approved charge for a Razorpay-verified payment, and a Supabase magic link for a password-based login.

**Tech Stack:** Node/Express/TypeScript (`server/`), Postgres, Shopify Admin GraphQL API (this codebase's first GraphQL Admin API usage — every existing Shopify call is REST), Supabase Auth Admin API, React/Vite (`src/`). No new npm dependencies — every external call is hand-rolled `fetch`, matching this codebase's established convention for every integration (Shopify, Meta, Google, Razorpay, Shiprocket, Delhivery).

**Spec:** docs/superpowers/specs/2026-10-20-shopify-app-store-design.md

## Known uncertainties — verify before considering the owning task done

Flagged explicitly rather than silently assumed, same discipline this session has
applied to every other best-effort external integration (e.g. Shiprocket's webhook
payload shape):

- **Shopify Billing API's exact GraphQL field names** (`appSubscriptionCreate`'s
  arguments, `AppSubscriptionLineItemInput`'s shape) are based on Shopify's documented
  schema as of this plan's writing. This codebase has no prior GraphQL Admin API call to
  verify the pattern against (every existing Shopify integration is REST). Task 4's
  implementer must confirm the exact mutation shape against Shopify's current GraphQL
  Admin API schema (shopify.dev's Billing API docs, or a schema introspection query)
  before marking the task done — not just trust this plan's literal code.
- **Billing currency.** The existing Razorpay plans are priced in INR
  (`plans.monthly_fee_inr`). Shopify's Billing API's currency handling (whether it bills
  in the merchant's local currency, a fixed USD price, or something configured per Partner
  app) needs to be confirmed before Task 4 hardcodes a `currencyCode`. If Shopify requires
  USD, Task 4 needs a separate, explicitly-Shopify-channel price table rather than reusing
  `plans.monthly_fee_inr` directly — do not silently convert at a guessed exchange rate.

## Global Constraints

- No new npm dependencies — hand-rolled `fetch` only, matching every existing integration.
- `server/src/integrations/shopify.ts`'s `shopifyConnector` (used by the live
  agency-connect flow and the install-link flow) is NOT touched by this plan. If any
  task's implementation seems to require changing it, stop and report.
- This is an **additional** acquisition channel — `/pricing` + Razorpay self-serve signup
  stays completely unchanged.
- Redirect-out model — the merchant's ongoing dashboard experience is the existing,
  unchanged `d2c.probild.in`. No Polaris, no App Bridge session-token auth for ongoing
  use, no embedded iframe rebuild of any dashboard screen.
- Mirrors the existing 4 pricing tiers (Small/Medium/Large; Enterprise stays
  Contact-Us-only, not purchasable through this channel) — same `order_limit` soft-caps.
- Every new self-serve-style account gets `account_type = 'self_serve_owner'` (same
  staff-gating as the Razorpay channel — reuses `isStaffMember`, no new access-control
  code).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Review Focus

- A merchant who installs, then uninstalls, then reinstalls must not get a second,
  duplicate account for the same shop — the existing `clients` row (looked up by
  `shopify_shop_domain`) must be reused, not re-provisioned. Test in Task 5.
- A merchant who abandons the flow after OAuth but before approving the Shopify billing
  charge must not end up with a half-provisioned account that silently exists with no
  active subscription — either the whole provisioning transaction rolls back, or the
  account exists in a clearly-incomplete, clearly-recoverable state the merchant can
  resume into. Test in Task 5/6.
- The 3 mandatory GDPR webhooks must verify Shopify's HMAC using the App Store app's
  OWN secret (`SHOPIFY_APP_STORE_CLIENT_SECRET`), never the existing agency-connect app's
  secret — a wrong-secret bug here would either reject every genuine Shopify webhook or
  (worse) accept a forged one. Test in Task 7.
- A concurrent double-callback for the same install (e.g. a merchant double-clicking
  "Install," or Shopify retrying a slow callback) must not create two `clients` rows or
  two Supabase users for the same shop — needs a real concurrency test, not just a
  sequential one. Test in Task 5.
- The Shopify billing webhook (`app_subscriptions/update`) must never be mistaken for a
  Razorpay webhook event, and vice versa — `subscriptions.billing_provider` must
  genuinely gate both handlers so neither ever processes a charge id belonging to the
  other system. Test in Task 7.

---

### Task 1: Migration — `clients.shopify_shop_domain` and `subscriptions.billing_provider`

**Files:**
- Create: `server/migrations/017_shopify_app_store.sql`
- Test: `server/test/migration-017.test.ts`

**Interfaces:**
- Produces: `clients.shopify_shop_domain text unique` (nullable — only set for
  Shopify-App-Store-provisioned clients), `subscriptions.billing_provider text not null
  default 'razorpay' check (billing_provider in ('razorpay', 'shopify'))`.

- [ ] **Step 1: Write the migration**

```sql
-- server/migrations/017_shopify_app_store.sql
-- Supports the Shopify App Store app: a brand-new account-acquisition channel alongside
-- the existing agency-connect and Razorpay self-serve flows. See
-- docs/superpowers/specs/2026-10-20-shopify-app-store-design.md.

-- Lets the install callback recognize a reinstall of an already-provisioned shop,
-- instead of creating a duplicate account.
alter table clients add column shopify_shop_domain text unique;

-- Distinguishes which billing system backs a subscription, so the existing Razorpay
-- webhook handler and this plan's new Shopify billing webhook handler never process a
-- charge id that belongs to the other system.
alter table subscriptions add column billing_provider text not null default 'razorpay' check (billing_provider in ('razorpay', 'shopify'));
```

- [ ] **Step 2: Write the test**

```typescript
// server/test/migration-017.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

describe("migration 017: shopify app store", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
  });

  it("allows setting shopify_shop_domain and enforces uniqueness", async () => {
    await testPool.query("update clients set shopify_shop_domain = 'abc-fashion.myshopify.com' where id = 'abc-fashion'");
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('xyz-beauty', 'XYZ Beauty', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await expect(
      testPool.query("update clients set shopify_shop_domain = 'abc-fashion.myshopify.com' where id = 'xyz-beauty'"),
    ).rejects.toThrow();
  });

  it("existing clients have no shopify_shop_domain by default", async () => {
    const res = await testPool.query("select shopify_shop_domain from clients where id = 'abc-fashion'");
    expect(res.rows[0].shopify_shop_domain).toBeNull();
  });

  it("subscriptions default to billing_provider = 'razorpay' and accept 'shopify'", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'small', 'active')`,
    );
    const defaultRow = await testPool.query("select billing_provider from subscriptions where client_id = 'abc-fashion'");
    expect(defaultRow.rows[0].billing_provider).toBe("razorpay");

    await testPool.query("update subscriptions set billing_provider = 'shopify' where client_id = 'abc-fashion'");
    const updated = await testPool.query("select billing_provider from subscriptions where client_id = 'abc-fashion'");
    expect(updated.rows[0].billing_provider).toBe("shopify");
  });

  it("rejects an unrecognized billing_provider", async () => {
    await expect(
      testPool.query(
        `insert into subscriptions (client_id, plan_id, status, billing_provider) values ('abc-fashion', 'small', 'active', 'stripe')`,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/migration-017.test.ts`
Expected: FAIL — column does not exist.

- [ ] **Step 4: Run test to verify it passes**

Run the same command. Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/migrations/017_shopify_app_store.sql server/test/migration-017.test.ts
git commit -m "feat(server): add clients.shopify_shop_domain and subscriptions.billing_provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `supabase-admin.ts` — passwordless user creation + magic link generation

**Files:**
- Modify: `server/src/lib/supabase-admin.ts`
- Modify: `server/test/lib/supabase-admin.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createSupabaseUser(email: string, password?: string): Promise<{ id: string }>`
  (password now optional — omitting it creates a user with no password set, who can only
  ever authenticate via a magic link/OTP, exactly the passwordless case this plan needs).
  `generateMagicLink(email: string): Promise<{ actionLink: string }>`.

- [ ] **Step 1: Read the existing file first**

Read `server/src/lib/supabase-admin.ts` in full (already read above in this session) —
confirm the exact current `createSupabaseUser` signature and body before editing it.

- [ ] **Step 2: Write the failing tests**

Add to `server/test/lib/supabase-admin.test.ts`:

```typescript
describe("createSupabaseUser without a password", () => {
  it("omits the password field entirely when none is given", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }), { status: 200 });
      }),
    );
    const result = await createSupabaseUser("riya@newbrand.com");
    expect(result).toEqual({ id: "11111111-1111-1111-1111-111111111111" });
    expect(capturedBody).not.toHaveProperty("password");
    expect(capturedBody).toMatchObject({ email: "riya@newbrand.com", email_confirm: true });
  });
});

describe("generateMagicLink", () => {
  it("requests a magiclink and returns the action link", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://test-project.supabase.co/auth/v1/admin/generate_link");
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({ type: "magiclink", email: "riya@newbrand.com" });
        return new Response(JSON.stringify({ properties: { action_link: "https://test-project.supabase.co/auth/v1/verify?token=abc" } }), { status: 200 });
      }),
    );
    const result = await generateMagicLink("riya@newbrand.com");
    expect(result).toEqual({ actionLink: "https://test-project.supabase.co/auth/v1/verify?token=abc" });
  });

  it("throws a clear error on a non-2xx response", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));
    await expect(generateMagicLink("riya@newbrand.com")).rejects.toThrow(/Failed to generate magic link/);
  });
});
```

Add `createSupabaseUser`/`generateMagicLink` to this file's existing import line.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/supabase-admin.test.ts`
Expected: FAIL — `generateMagicLink` not exported; `createSupabaseUser` still requires `password`.

- [ ] **Step 4: Implement**

In `server/src/lib/supabase-admin.ts`, change `createSupabaseUser`'s signature and body:

```typescript
export async function createSupabaseUser(email: string, password?: string): Promise<{ id: string }> {
  const { url, serviceRoleKey } = getCredentials();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify(password ? { email, password, email_confirm: true } : { email, email_confirm: true }),
  });
  // ...rest of the function body is unchanged — the 422/error handling below this line
  // does not need to change.
```

Add a new function, alongside the existing ones:

```typescript
export async function generateMagicLink(email: string): Promise<{ actionLink: string }> {
  const { url, serviceRoleKey } = getCredentials();
  const res = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!res.ok) {
    throw new Error(`Failed to generate magic link: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { properties: { action_link: string } };
  return { actionLink: body.properties.action_link };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/supabase-admin.test.ts`
Expected: PASS (all existing tests + 3 new ones).

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green. (Making `password` optional must not break the existing Razorpay signup flow's call site, which always passes one — confirm `server/src/routes/signup.ts`'s existing `createSupabaseUser(normalizedEmail, password)` call still compiles and its tests still pass.)

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/supabase-admin.ts server/test/lib/supabase-admin.test.ts
git commit -m "feat(server): support passwordless Supabase users and magic-link generation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `shopify-app-oauth.ts` — standalone OAuth exchange for the App Store app

**Files:**
- Create: `server/src/integrations/shopify-app-oauth.ts`
- Test: `server/test/integrations/shopify-app-oauth.test.ts`

**Interfaces:**
- Consumes: `normalizeShopDomain` (`server/src/lib/shop-domain.ts`).
- Produces: `getShopifyAppInstallUrl(shop: string, state: string): string`,
  `exchangeShopifyAppCode(query: Record<string, string>): Promise<{ shop: string; accessToken: string }>` (throws on missing params, invalid shop domain, or failed HMAC/token exchange), `getShopInfo(shop: string, accessToken: string): Promise<{ email: string; name: string }>`.

This deliberately duplicates `server/src/integrations/shopify.ts`'s HMAC-verify and
token-exchange logic rather than reusing `shopifyConnector.handleCallback` — see this
plan's Architecture section for why (that function is shared, production-critical
infrastructure for flows this plan must not touch or risk).

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/integrations/shopify-app-oauth.test.ts
import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getShopifyAppInstallUrl, exchangeShopifyAppCode, getShopInfo } from "../../src/integrations/shopify-app-oauth.js";

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map((key) => `${key}=${rest[key]}`).join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

beforeEach(() => {
  process.env.SHOPIFY_APP_STORE_CLIENT_ID = "test-app-store-client-id";
  process.env.SHOPIFY_APP_STORE_CLIENT_SECRET = "test-app-store-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getShopifyAppInstallUrl", () => {
  it("builds Shopify's authorize URL with this app's own client id", () => {
    const url = getShopifyAppInstallUrl("abc-fashion.myshopify.com", "signed-state");
    expect(url).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
    expect(url).toContain("client_id=test-app-store-client-id");
    expect(url).toContain("state=signed-state");
  });
});

describe("exchangeShopifyAppCode", () => {
  it("verifies the HMAC, exchanges the code, and returns the shop + access token", async () => {
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state: "x", timestamp: "123" };
    const hmac = computeTestHmac(query, "test-app-store-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_appstore_token" }), { status: 200 })),
    );
    const result = await exchangeShopifyAppCode({ ...query, hmac });
    expect(result).toEqual({ shop: "abc-fashion.myshopify.com", accessToken: "shpat_appstore_token" });
  });

  it("throws on a bad HMAC", async () => {
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state: "x", hmac: "0".repeat(64) };
    await expect(exchangeShopifyAppCode(query)).rejects.toThrow(/HMAC/);
  });

  it("throws when shop or code is missing", async () => {
    await expect(exchangeShopifyAppCode({ hmac: "x" })).rejects.toThrow(/shop or code/);
  });
});

describe("getShopInfo", () => {
  it("fetches the shop's own contact email and name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://abc-fashion.myshopify.com/admin/api/2024-10/shop.json");
        return new Response(JSON.stringify({ shop: { email: "owner@newbrand.com", name: "New Brand Co" } }), { status: 200 });
      }),
    );
    const info = await getShopInfo("abc-fashion.myshopify.com", "shpat_token");
    expect(info).toEqual({ email: "owner@newbrand.com", name: "New Brand Co" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/integrations/shopify-app-oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/integrations/shopify-app-oauth.ts
import crypto from "node:crypto";
import { normalizeShopDomain } from "../lib/shop-domain.js";

const SHOPIFY_APP_SCOPES = "read_orders,read_products,read_customers";

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.SHOPIFY_APP_STORE_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_STORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_APP_STORE_CLIENT_ID and SHOPIFY_APP_STORE_CLIENT_SECRET environment variables must be set");
  }
  return { clientId, clientSecret };
}

function getRedirectUri(): string {
  const apiUrl = process.env.PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${apiUrl}/api/shopify-app/callback`;
}

export function getShopifyAppInstallUrl(shop: string, state: string): string {
  const { clientId } = getCredentials();
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SHOPIFY_APP_SCOPES);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

function verifyCallbackHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map((key) => `${key}=${rest[key]}`).join("&");
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(hmac, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export async function exchangeShopifyAppCode(query: Record<string, string>): Promise<{ shop: string; accessToken: string }> {
  const shop = query.shop;
  const code = query.code;
  if (!shop || !code) {
    throw new Error("Shopify callback missing shop or code query parameter");
  }
  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    throw new Error("Shopify callback shop parameter is not a valid *.myshopify.com domain");
  }
  const { clientId, clientSecret } = getCredentials();
  if (!verifyCallbackHmac(query, clientSecret)) {
    throw new Error("Shopify App Store callback failed HMAC verification");
  }
  const res = await fetch(`https://${normalizedShop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) {
    throw new Error(`Shopify App Store token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string };
  return { shop: normalizedShop, accessToken: body.access_token };
}

export async function getShopInfo(shop: string, accessToken: string): Promise<{ email: string; name: string }> {
  const res = await fetch(`https://${shop}/admin/api/2024-10/shop.json`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch shop info: ${res.status}`);
  }
  const body = (await res.json()) as { shop: { email: string; name: string } };
  return { email: body.shop.email, name: body.shop.name };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/integrations/shopify-app-oauth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean, full suite green.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/shopify-app-oauth.ts server/test/integrations/shopify-app-oauth.test.ts
git commit -m "feat(server): add standalone Shopify OAuth exchange for the App Store app

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `shopify-billing.ts` — Shopify Billing API wrapper

**Files:**
- Create: `server/src/integrations/shopify-billing.ts`
- Test: `server/test/integrations/shopify-billing.test.ts`

**Interfaces:**
- Produces: `createAppSubscription(shop: string, accessToken: string, planId: "small" | "medium" | "large", returnUrl: string): Promise<{ confirmationUrl: string; subscriptionGid: string }>`, `getAppSubscription(shop: string, accessToken: string, subscriptionGid: string): Promise<{ status: string; name: string }>`.

**Before writing this task's implementation**, resolve the two "Known uncertainties" this
plan flags at the top (exact GraphQL field names, currency handling) against Shopify's
current Billing API documentation — do not transcribe the code below without confirming
it first; adapt field names/currency if they've drifted from what's written here, and
note the correction clearly in your report.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/integrations/shopify-billing.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createAppSubscription, getAppSubscription } from "../../src/integrations/shopify-billing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAppSubscription", () => {
  it("sends a GraphQL appSubscriptionCreate mutation and returns the confirmation URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://abc-fashion.myshopify.com/admin/api/2024-10/graphql.json");
        expect((init?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_token");
        const body = JSON.parse(init?.body as string);
        expect(body.query).toContain("appSubscriptionCreate");
        expect(body.variables.name).toBe("Medium");
        return new Response(
          JSON.stringify({
            data: {
              appSubscriptionCreate: {
                appSubscription: { id: "gid://shopify/AppSubscription/1" },
                confirmationUrl: "https://abc-fashion.myshopify.com/admin/charges/1/confirm",
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        );
      }),
    );
    const result = await createAppSubscription("abc-fashion.myshopify.com", "shpat_token", "medium", "https://d2c.probild.in/api/shopify-app/billing-callback");
    expect(result).toEqual({ confirmationUrl: "https://abc-fashion.myshopify.com/admin/charges/1/confirm", subscriptionGid: "gid://shopify/AppSubscription/1" });
  });

  it("throws if Shopify returns userErrors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: null, confirmationUrl: null, userErrors: [{ field: ["name"], message: "Name can't be blank" }] } } }),
          { status: 200 },
        ),
      ),
    );
    await expect(createAppSubscription("abc-fashion.myshopify.com", "shpat_token", "small", "https://d2c.probild.in/x")).rejects.toThrow(/Name can't be blank/);
  });
});

describe("getAppSubscription", () => {
  it("queries the subscription's current status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { node: { status: "ACTIVE", name: "Medium" } } }), { status: 200 }),
      ),
    );
    const result = await getAppSubscription("abc-fashion.myshopify.com", "shpat_token", "gid://shopify/AppSubscription/1");
    expect(result).toEqual({ status: "ACTIVE", name: "Medium" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/integrations/shopify-billing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/integrations/shopify-billing.ts
const PLAN_PRICES_USD: Record<"small" | "medium" | "large", number> = {
  // Verify against Shopify's actual currency rules before relying on these values — see
  // this plan's "Known uncertainties" section. Placeholder USD figures roughly matching
  // the existing INR prices at a round conversion; replace with confirmed values.
  small: 19,
  medium: 39,
  large: 79,
};

const PLAN_NAMES: Record<"small" | "medium" | "large", string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

async function shopifyGraphql(shop: string, accessToken: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function createAppSubscription(
  shop: string,
  accessToken: string,
  planId: "small" | "medium" | "large",
  returnUrl: string,
): Promise<{ confirmationUrl: string; subscriptionGid: string }> {
  const mutation = `
    mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
      appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }
  `;
  const variables = {
    name: PLAN_NAMES[planId],
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: PLAN_PRICES_USD[planId], currencyCode: "USD" },
            interval: "EVERY_30_DAYS",
          },
        },
      },
    ],
    returnUrl,
  };
  const body = await shopifyGraphql(shop, accessToken, mutation, variables);
  const result = body.data.appSubscriptionCreate;
  if (result.userErrors?.length > 0) {
    throw new Error(`Shopify rejected the subscription: ${result.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
  }
  return { confirmationUrl: result.confirmationUrl, subscriptionGid: result.appSubscription.id };
}

export async function getAppSubscription(shop: string, accessToken: string, subscriptionGid: string): Promise<{ status: string; name: string }> {
  const query = `
    query GetAppSubscription($id: ID!) {
      node(id: $id) {
        ... on AppSubscription { status name }
      }
    }
  `;
  const body = await shopifyGraphql(shop, accessToken, query, { id: subscriptionGid });
  return { status: body.data.node.status, name: body.data.node.name };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/integrations/shopify-billing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean, full suite green.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/shopify-billing.ts server/test/integrations/shopify-billing.test.ts
git commit -m "feat(server): add the Shopify Billing API wrapper for App Store subscriptions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Install + callback routes — OAuth and atomic provisioning

**Files:**
- Create: `server/src/routes/shopify-app-install.ts`
- Test: `server/test/routes/shopify-app-install.test.ts`

**Interfaces:**
- Consumes: `getShopifyAppInstallUrl`/`exchangeShopifyAppCode`/`getShopInfo` (Task 3),
  `signState`/`verifyState` (`server/src/lib/state-token.ts`, already supports
  `shopDomain` with no `clientId`/`teamMemberId` — reuse directly, no changes needed),
  `createSupabaseUser` (Task 2, called with no password), `generateUniqueClientId`/`pickLogoColor` (`server/src/lib/slug.ts`), `deleteSupabaseUser` (`server/src/lib/supabase-admin.ts`).
- Produces: `GET /api/shopify-app/install?shop=<anything normalizeShopDomain accepts>`,
  `GET /api/shopify-app/callback`. On success, provisions a `client`/`team_member`/`team_member_clients` row (NOT a `subscriptions` row yet — that's Task 6, after the merchant picks a plan) and redirects to `${FRONTEND_URL}/#/shopify-app/plans?client=<clientId>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/routes/shopify-app-install.test.ts
import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map((key) => `${key}=${rest[key]}`).join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

beforeEach(async () => {
  await resetTestDb();
  process.env.SHOPIFY_APP_STORE_CLIENT_ID = "test-app-store-client-id";
  process.env.SHOPIFY_APP_STORE_CLIENT_SECRET = "test-app-store-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
  process.env.FRONTEND_URL = "https://d2c.probild.in";
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fakeShopifyCallback(stateToken: string, overrides: { email?: string; name?: string } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/admin/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "shpat_newbrand_token" }), { status: 200 });
      }
      if (url.includes("/shop.json")) {
        return new Response(
          JSON.stringify({ shop: { email: overrides.email ?? "owner@newbrand.com", name: overrides.name ?? "New Brand Co" } }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  const query = { shop: "newbrand.myshopify.com", code: "auth-code", state: stateToken, timestamp: "123" };
  const hmac = computeTestHmac(query, "test-app-store-secret");
  return request(app).get("/api/shopify-app/callback").query({ ...query, hmac });
}

describe("GET /api/shopify-app/install", () => {
  it("redirects to Shopify's authorize screen with this app's own client id, no auth required", async () => {
    const res = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://newbrand.myshopify.com/admin/oauth/authorize");
    expect(res.headers.location).toContain("client_id=test-app-store-client-id");
  });

  it("redirects to a friendly error for an unrecognizable shop", async () => {
    const res = await request(app).get("/api/shopify-app/install").query({ shop: "not a store" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
  });
});

describe("GET /api/shopify-app/callback", () => {
  it("provisions a new client, owner, and Shopify connection, then redirects to the plan picker", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;

    const res = await fakeShopifyCallback(state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");

    const clients = await testPool.query("select id, name, category, shopify_shop_domain from clients where shopify_shop_domain = 'newbrand.myshopify.com'");
    expect(clients.rowCount).toBe(1);
    expect(clients.rows[0]).toMatchObject({ name: "New Brand Co", category: "Uncategorized" });

    const teamMembers = await testPool.query("select name, email, role, account_type from team_members where email = 'owner@newbrand.com'");
    expect(teamMembers.rows[0]).toMatchObject({ role: "owner", account_type: "self_serve_owner" });

    const connections = await testPool.query("select platform, external_account_id from platform_connections where client_id = $1", [clients.rows[0].id]);
    expect(connections.rows[0]).toMatchObject({ platform: "shopify", external_account_id: "newbrand.myshopify.com" });
  });

  it("reuses the existing client on a reinstall, rather than creating a duplicate", async () => {
    const install1 = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state1 = new URL(install1.headers.location).searchParams.get("state")!;
    await fakeShopifyCallback(state1);

    const install2 = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state2 = new URL(install2.headers.location).searchParams.get("state")!;
    const res2 = await fakeShopifyCallback(state2);
    expect(res2.status).toBe(302);

    const clients = await testPool.query("select count(*)::int as count from clients where shopify_shop_domain = 'newbrand.myshopify.com'");
    expect(clients.rows[0].count).toBe(1);
  });

  it("rejects an invalid HMAC", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const res = await request(app)
      .get("/api/shopify-app/callback")
      .query({ shop: "newbrand.myshopify.com", code: "auth-code", state, hmac: "0".repeat(64) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'newbrand.myshopify.com'")).rowCount).toBe(0);
  });

  it("only lets one of two concurrent callbacks for the same new shop create a client", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "shpat_newbrand_token" }), { status: 200 });
        if (url.includes("/shop.json")) return new Response(JSON.stringify({ shop: { email: "owner@newbrand.com", name: "New Brand Co" } }), { status: 200 });
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const query = { shop: "newbrand.myshopify.com", code: "auth-code", state, timestamp: "123" };
    const hmac = computeTestHmac(query, "test-app-store-secret");
    const [first, second] = await Promise.all([
      request(app).get("/api/shopify-app/callback").query({ ...query, hmac }),
      request(app).get("/api/shopify-app/callback").query({ ...query, hmac }),
    ]);
    expect([first.status, second.status]).toEqual([302, 302]);
    const clients = await testPool.query("select count(*)::int as count from clients where shopify_shop_domain = 'newbrand.myshopify.com'");
    expect(clients.rows[0].count).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/shopify-app-install.test.ts`
Expected: FAIL — 404, route doesn't exist.

- [ ] **Step 3: Write the route**

```typescript
// server/src/routes/shopify-app-install.ts
import { Router } from "express";
import pool from "../db.js";
import { getShopifyAppInstallUrl, exchangeShopifyAppCode, getShopInfo } from "../integrations/shopify-app-oauth.js";
import { signState, verifyState } from "../lib/state-token.js";
import { normalizeShopDomain } from "../lib/shop-domain.js";
import { createSupabaseUser, deleteSupabaseUser } from "../lib/supabase-admin.js";
import { generateUniqueClientId, pickLogoColor } from "../lib/slug.js";
import { encryptToken } from "../lib/crypto.js";

const router = Router();

router.get("/install", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const shop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
  if (!shop) {
    const params = new URLSearchParams({ connection: "error", message: "That doesn't look like a Shopify store." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
    return;
  }
  const state = await signState({ platform: "shopify-app-store", shopDomain: shop });
  res.redirect(getShopifyAppInstallUrl(shop, state));
});

router.get("/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  try {
    const { shop, accessToken } = await exchangeShopifyAppCode(req.query as Record<string, string>);
    await verifyState(req.query.state as string); // throws if the state is missing/expired/tampered

    // Reinstall: reuse the existing client rather than provisioning a duplicate.
    const existing = await pool.query<{ id: string }>("select id from clients where shopify_shop_domain = $1", [shop]);
    let clientId: string;
    if (existing.rowCount && existing.rowCount > 0) {
      clientId = existing.rows[0].id;
      // Refresh the stored access token (Shopify may have reissued one on reinstall).
      await pool.query(
        `update platform_connections set access_token = $1, status = 'connected' where client_id = $2 and platform = 'shopify'`,
        [encryptToken(accessToken), clientId],
      );
    } else {
      const shopInfo = await getShopInfo(shop, accessToken);
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");
        clientId = await generateUniqueClientId(pool, shopInfo.name || shop);
        const logoColor = pickLogoColor(clientId);
        const logoInitial = (shopInfo.name || shop).trim().charAt(0).toUpperCase();

        const user = await createSupabaseUser(shopInfo.email);

        try {
          await dbClient.query(
            `insert into team_members (id, name, email, role, all_client_access, account_type) values ($1, $2, $3, 'owner', false, 'self_serve_owner')`,
            [user.id, shopInfo.name || shop, shopInfo.email],
          );
          await dbClient.query(
            `insert into clients (id, name, category, logo_color, logo_initial, owner_id, shopify_shop_domain) values ($1, $2, 'Uncategorized', $3, $4, $5, $6)`,
            [clientId, shopInfo.name || shop, logoColor, logoInitial, user.id, shop],
          );
          await dbClient.query(`insert into team_member_clients (team_member_id, client_id) values ($1, $2)`, [user.id, clientId]);
          await dbClient.query(
            `insert into platform_connections (client_id, platform, external_account_id, access_token, status, connected_by) values ($1, 'shopify', $2, $3, 'connected', $4)`,
            [clientId, shop, encryptToken(accessToken), user.id],
          );
          await dbClient.query("COMMIT");
        } catch (err) {
          await dbClient.query("ROLLBACK");
          await deleteSupabaseUser(user.id);
          // A concurrent callback for the same shop that raced this one and won loses
          // here, on clients.shopify_shop_domain's unique constraint — fall through to
          // re-look-up the row the winner created, rather than erroring.
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === "23505" && pgErr.constraint?.includes("shopify_shop_domain")) {
            const winner = await pool.query<{ id: string }>("select id from clients where shopify_shop_domain = $1", [shop]);
            clientId = winner.rows[0].id;
          } else {
            throw err;
          }
        }
      } finally {
        dbClient.release();
      }
    }

    const params = new URLSearchParams({ client: clientId });
    res.redirect(`${frontendUrl}/#/shopify-app/plans?${params.toString()}`);
  } catch (err) {
    const params = new URLSearchParams({ connection: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
  }
});

export default router;
```

Note on the concurrency test: the `try/catch` around the inner transaction specifically
handles the case where two near-simultaneous callbacks for the same brand-new shop both
pass the `existing.rowCount === 0` check before either commits — the loser's `clients`
insert fails on the unique `shopify_shop_domain` constraint, its Supabase user is cleaned
up, and it falls through to adopt the winner's `clientId` rather than erroring, so both
requests redirect successfully to the SAME plan-picker for the ONE real client that
exists.

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, add the import and mount (public route, no `requireAuth`, alongside the other public routers like `signupRouter`):
```typescript
import shopifyAppInstallRouter from "./routes/shopify-app-install.js";
...
app.use("/api/shopify-app", shopifyAppInstallRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/shopify-app-install.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean, full suite green.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/shopify-app-install.ts server/test/routes/shopify-app-install.test.ts server/src/index.ts
git commit -m "feat(server): add Shopify App Store install + callback routes with atomic, reinstall-safe provisioning

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Plan selection, Shopify billing confirmation, and auto-login

**Files:**
- Modify: `server/src/routes/shopify-app-install.ts` (add 2 more routes to the same router)
- Modify: `server/test/routes/shopify-app-install.test.ts`

**Interfaces:**
- Consumes: `createAppSubscription`/`getAppSubscription` (Task 4), `generateMagicLink`
  (Task 2), `getPlanIdFromRazorpayPlanId`-style plan validation (reuse the existing
  `isSelfServePlanId`-equivalent pattern from `server/src/routes/signup.ts` — a hardcoded
  `["small","medium","large"]` array, not Enterprise).
- Produces: `POST /api/shopify-app/:clientId/subscribe` (body `{ planId }`, returns `{
  confirmationUrl }` to redirect the merchant's browser to Shopify's own charge-approval
  screen), `GET /api/shopify-app/billing-callback` (Shopify's redirect back after the
  merchant approves/declines; on approval, activates the subscription and redirects to
  the dashboard already logged in via a magic link; on decline, redirects back to the
  plan picker with an error).

- [ ] **Step 1: Write the failing tests**

Add to `server/test/routes/shopify-app-install.test.ts` (reuse this file's existing
`beforeEach` seed pattern — provision a client first via the install+callback flow the
same way Task 5's tests do, then test these two new routes against it):

```typescript
describe("POST /api/shopify-app/:clientId/subscribe", () => {
  it("creates a Shopify charge and returns its confirmation URL", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://newbrand.myshopify.com/admin/api/2024-10/graphql.json");
        return new Response(
          JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }),
          { status: 200 },
        );
      }),
    );
    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm" });

    const subs = await testPool.query("select plan_id, status, billing_provider from subscriptions where client_id = $1", [clientId]);
    expect(subs.rows[0]).toMatchObject({ plan_id: "medium", status: "pending", billing_provider: "shopify" });
  });

  it("rejects enterprise", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;
    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "enterprise" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/shopify-app/billing-callback", () => {
  it("activates the subscription and redirects through a real magic link on approval", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/graphql.json")) {
          const body = JSON.parse(init?.body as string);
          if (body.query.includes("appSubscriptionCreate")) {
            return new Response(JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: { node: { status: "ACTIVE", name: "Medium" } } }), { status: 200 });
        }
        if (url.includes("/admin/generate_link")) {
          return new Response(JSON.stringify({ properties: { action_link: "https://test-project.supabase.co/auth/v1/verify?token=magic" } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium" });

    const res = await request(app).get("/api/shopify-app/billing-callback").query({ client: clientId, charge_id: "1" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://test-project.supabase.co/auth/v1/verify?token=magic");

    const subs = await testPool.query("select status from subscriptions where client_id = $1", [clientId]);
    expect(subs.rows[0].status).toBe("active");
  });
});
```

Add `process.env.SUPABASE_URL = "https://test-project.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";` to this file's `beforeEach` (needed for `generateMagicLink`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/shopify-app-install.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Write the routes**

Add to `server/src/routes/shopify-app-install.ts`:

```typescript
import { createAppSubscription, getAppSubscription } from "../integrations/shopify-billing.js";
import { generateMagicLink } from "../lib/supabase-admin.js";
import { HttpError } from "../lib/http-error.js";

const SELF_SERVE_PLAN_IDS = ["small", "medium", "large"] as const;
type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];
function isSelfServePlanId(value: unknown): value is SelfServePlanId {
  return typeof value === "string" && (SELF_SERVE_PLAN_IDS as readonly string[]).includes(value);
}

router.post("/:clientId/subscribe", async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { planId } = req.body as { planId?: string };
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }
    const connResult = await pool.query<{ external_account_id: string; access_token: string }>(
      `select external_account_id, access_token from platform_connections where client_id = $1 and platform = 'shopify'`,
      [clientId],
    );
    if (connResult.rowCount === 0) {
      throw new HttpError(404, "not_found", "No Shopify connection for this client");
    }
    const shop = connResult.rows[0].external_account_id;
    const accessToken = decryptToken(connResult.rows[0].access_token);
    const returnUrl = `${process.env.PUBLIC_API_URL}/api/shopify-app/billing-callback?client=${clientId}`;

    const { confirmationUrl, subscriptionGid } = await createAppSubscription(shop, accessToken, planId, returnUrl);

    await pool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values ($1, $2, 'pending', $3, 'shopify')
       on conflict (client_id) do update set plan_id = excluded.plan_id, status = 'pending', gateway_subscription_id = excluded.gateway_subscription_id, billing_provider = 'shopify'`,
      [clientId, planId, subscriptionGid],
    );

    res.json({ confirmationUrl });
  } catch (err) {
    next(err);
  }
});

router.get("/billing-callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const clientId = req.query.client as string;
  try {
    const subResult = await pool.query<{ gateway_subscription_id: string; email: string }>(
      `select s.gateway_subscription_id, tm.email from subscriptions s
       join clients c on c.id = s.client_id join team_members tm on tm.id = c.owner_id
       where s.client_id = $1 and s.billing_provider = 'shopify'`,
      [clientId],
    );
    if (subResult.rowCount === 0) {
      throw new Error("No pending Shopify subscription for this client");
    }
    const { gateway_subscription_id: subscriptionGid, email } = subResult.rows[0];

    const connResult = await pool.query<{ external_account_id: string; access_token: string }>(
      `select external_account_id, access_token from platform_connections where client_id = $1 and platform = 'shopify'`,
      [clientId],
    );
    const shop = connResult.rows[0].external_account_id;
    const accessToken = decryptToken(connResult.rows[0].access_token);

    const { status } = await getAppSubscription(shop, accessToken, subscriptionGid);
    if (status !== "ACTIVE") {
      const params = new URLSearchParams({ client: clientId, billing: "declined" });
      res.redirect(`${frontendUrl}/#/shopify-app/plans?${params.toString()}`);
      return;
    }

    await pool.query("update subscriptions set status = 'active' where client_id = $1", [clientId]);

    const { actionLink } = await generateMagicLink(email);
    res.redirect(actionLink);
  } catch (err) {
    const params = new URLSearchParams({ connection: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
  }
});
```

Also add `import { decryptToken } from "../lib/crypto.js";` to this file's imports if not
already present from Task 5 (it is — Task 5 only imports `encryptToken`; add
`decryptToken` alongside it).

Note: the `subscriptions` insert's `on conflict (client_id)` requires
`subscriptions.client_id` to have a unique constraint — confirm this already exists
(`server/migrations/001_init_schema.sql`'s `subscriptions.client_id` is declared `unique`)
before assuming the `on conflict` target is valid.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/shopify-app-install.test.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean, full suite green.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/shopify-app-install.ts server/test/routes/shopify-app-install.test.ts
git commit -m "feat(server): add Shopify billing confirmation and magic-link auto-login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Mandatory GDPR webhooks + the Shopify billing status webhook

**Files:**
- Create: `server/src/routes/shopify-app-webhooks.ts`
- Test: `server/test/routes/shopify-app-webhooks.test.ts`

**Interfaces:**
- Consumes: HMAC verification (same scheme as Task 3's `verifyCallbackHmac`, but applied
  to a raw request body, not query params — matching how `server/src/routes/shopify-webhooks.ts`
  already verifies the existing order webhooks' raw-body HMAC; read that file first for
  the exact pattern to mirror).
- Produces: `POST /api/webhooks/shopify-app/customers/data-request`,
  `POST /api/webhooks/shopify-app/customers/redact`, `POST /api/webhooks/shopify-app/shop/redact`,
  `POST /api/webhooks/shopify-app/app-subscriptions-update` (Shopify's billing status
  push — a defense-in-depth backstop alongside Task 6's synchronous `billing-callback`
  confirmation, for cases like a merchant cancelling the subscription later from inside
  Shopify Admin, which only arrives via this webhook, never through the synchronous flow).

- [ ] **Step 1: Read the existing Shopify webhook route first**

Read `server/src/routes/shopify-webhooks.ts` in full — match its exact raw-body HMAC
verification pattern (the `express.raw()` middleware, the HMAC header name, the
buffer-vs-string comparison) rather than inventing a new one.

- [ ] **Step 2: Write the failing tests**

```typescript
// server/test/routes/shopify-app-webhooks.test.ts
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

function signBody(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

beforeEach(async () => {
  await resetTestDb();
  process.env.SHOPIFY_APP_STORE_CLIENT_SECRET = "test-app-store-secret";
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial, shopify_shop_domain) values
     ('new-brand-co', 'New Brand Co', 'Uncategorized', 'bg-violet-500', 'N', 'newbrand.myshopify.com')`,
  );
});

describe("POST /api/webhooks/shopify-app/shop/redact", () => {
  it("deletes the client's data when the shop closes, with a valid HMAC", async () => {
    const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'newbrand.myshopify.com'")).rowCount).toBe(0);
  });

  it("rejects an invalid HMAC and makes no change", async () => {
    const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", "invalid")
      .send(rawBody);
    expect(res.status).toBe(401);
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'newbrand.myshopify.com'")).rowCount).toBe(1);
  });
});

describe("POST /api/webhooks/shopify-app/customers/data-request and customers/redact", () => {
  it("200s both with a valid HMAC (no customer PII store beyond order-linked fields to act on)", async () => {
    for (const path of ["customers/data-request", "customers/redact"]) {
      const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com", customer: { id: 123, email: "buyer@example.com" } });
      const res = await request(app)
        .post(`/api/webhooks/shopify-app/${path}`)
        .set("Content-Type", "application/json")
        .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
        .send(rawBody);
      expect(res.status).toBe(200);
    }
  });
});

describe("POST /api/webhooks/shopify-app/app-subscriptions-update", () => {
  it("marks the subscription canceled when Shopify reports it canceled, scoped by billing_provider", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ('new-brand-co', 'medium', 'active', 'gid://shopify/AppSubscription/1', 'shopify')`,
    );
    const rawBody = JSON.stringify({ app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", status: "CANCELLED" } });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/app-subscriptions-update")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);
    const sub = await testPool.query("select status from subscriptions where client_id = 'new-brand-co'");
    expect(sub.rows[0].status).toBe("canceled");
  });

  it("never touches a razorpay-billed subscription with the same-looking gateway id", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ('new-brand-co', 'medium', 'active', 'gid://shopify/AppSubscription/1', 'razorpay')`,
    );
    const rawBody = JSON.stringify({ app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", status: "CANCELLED" } });
    await request(app)
      .post("/api/webhooks/shopify-app/app-subscriptions-update")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    const sub = await testPool.query("select status from subscriptions where client_id = 'new-brand-co'");
    expect(sub.rows[0].status).toBe("active"); // unchanged — billing_provider gate held
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/shopify-app-webhooks.test.ts`
Expected: FAIL — 404, routes don't exist.

- [ ] **Step 4: Write the routes**

```typescript
// server/src/routes/shopify-app-webhooks.ts
import express, { Router } from "express";
import crypto from "node:crypto";
import pool from "../db.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(express.raw({ type: "application/json" }));

function verifyWebhookHmac(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const secret = process.env.SHOPIFY_APP_STORE_CLIENT_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_APP_STORE_CLIENT_SECRET environment variable must be set");
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

router.post("/shop/redact", async (req, res) => {
  if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
    res.status(401).send();
    return;
  }
  const payload = JSON.parse((req.body as Buffer).toString("utf8")) as { shop_domain: string };
  // Deletes the whole client — cascades to team_members/subscriptions/shopify_orders/etc.
  // via the existing foreign-key "on delete cascade" chain already in place for every
  // other client-deletion path in this app.
  await pool.query("delete from clients where shopify_shop_domain = $1", [payload.shop_domain]);
  res.status(200).send();
});

router.post("/customers/data-request", async (req, res) => {
  if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
    res.status(401).send();
    return;
  }
  // This app stores no customer data beyond what's embedded in synced shopify_orders rows
  // (customer_name, city, state — no separate customer record). There is nothing further
  // to export beyond what Shopify itself already has; acknowledge the request.
  logger.info(req.body, "Shopify customers/data_request webhook received");
  res.status(200).send();
});

router.post("/customers/redact", async (req, res) => {
  if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
    res.status(401).send();
    return;
  }
  const payload = JSON.parse((req.body as Buffer).toString("utf8")) as { shop_domain: string; customer?: { id?: number } };
  logger.info(payload, "Shopify customers/redact webhook received");
  // No separate customer PII table to redact against for this data model today — flagged
  // explicitly, same discipline as this session's other best-effort external-payload
  // handlers, rather than silently claiming full compliance with no real redaction logic.
  res.status(200).send();
});

router.post("/app-subscriptions-update", async (req, res) => {
  if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
    res.status(401).send();
    return;
  }
  const payload = JSON.parse((req.body as Buffer).toString("utf8")) as {
    app_subscription: { admin_graphql_api_id: string; status: string };
  };
  const statusMap: Record<string, string> = { ACTIVE: "active", CANCELLED: "canceled", EXPIRED: "canceled", FROZEN: "past_due" };
  const newStatus = statusMap[payload.app_subscription.status];
  if (!newStatus) {
    res.status(200).send();
    return;
  }
  // billing_provider = 'shopify' is the load-bearing filter: without it, a gateway_subscription_id
  // string that happens to collide with a Razorpay-billed row's value would update the
  // wrong subscription.
  await pool.query(
    "update subscriptions set status = $1 where gateway_subscription_id = $2 and billing_provider = 'shopify'",
    [newStatus, payload.app_subscription.admin_graphql_api_id],
  );
  res.status(200).send();
});

export default router;
```

- [ ] **Step 5: Mount the router**

In `server/src/index.ts`, mount in the raw-body-before-`express.json()` group, alongside
the existing Shopify order webhooks:
```typescript
import shopifyAppWebhooksRouter from "./routes/shopify-app-webhooks.js";
...
app.use("/api/webhooks/shopify-app", shopifyAppWebhooksRouter);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/shopify-app-webhooks.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean, full suite green.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/shopify-app-webhooks.ts server/test/routes/shopify-app-webhooks.test.ts server/src/index.ts
git commit -m "feat(server): add mandatory Shopify GDPR webhooks and the App Subscriptions status webhook

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — plan picker + error page

**Files:**
- Create: `src/pages/shopify-app-plans.tsx`
- Create: `src/pages/shopify-app-error.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `publicApiFetch` (`src/lib/api.ts`, already exists from the Razorpay signup
  plan — no session required, matches this flow exactly), `GET /api/plans` (existing,
  unchanged), `POST /api/shopify-app/:clientId/subscribe` (Task 6).
- Produces: routes `/shopify-app/plans` and `/shopify-app/error`, both public (outside
  `RequireAuth` — same placement as `/pricing`/`/signup`/`/contact-enterprise`).

- [ ] **Step 1: Write the plan picker page**

```typescript
// src/pages/shopify-app-plans.tsx
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { publicApiFetch, ApiError } from "@/lib/api";

interface Plan {
  id: string;
  name: string;
  orderLimit: number | null;
  monthlyFeeInr: number;
}

export default function ShopifyAppPlans() {
  const [params] = useSearchParams();
  const clientId = params.get("client");
  const declined = params.get("billing") === "declined";
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [error, setError] = React.useState<string | null>(declined ? "Payment was not approved. Pick a plan to try again." : null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    publicApiFetch("/api/plans")
      .then((res) => res.json())
      .then((data: Plan[]) => setPlans(data.filter((p) => p.id !== "enterprise")))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load plans."));
  }, []);

  const choose = async (planId: string) => {
    if (!clientId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await publicApiFetch(`/api/shopify-app/${clientId}/subscribe`, { method: "POST", body: JSON.stringify({ planId }) });
      const { confirmationUrl } = await res.json();
      window.location.href = confirmationUrl;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong starting checkout.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg p-8">
      <h1 className="mb-2 text-2xl font-semibold text-text-primary">Choose a plan</h1>
      <p className="mb-6 text-sm text-text-secondary">Your store is connected — pick a plan to finish setup.</p>
      {error && <p className="mb-4 text-[13px] text-negative">{error}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-[var(--radius-lg)] border border-border bg-surface p-6">
            <h2 className="text-lg font-semibold text-text-primary">{plan.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">{plan.orderLimit ? `Up to ${plan.orderLimit} orders/month` : "Custom"}</p>
            <p className="mt-4 text-2xl font-bold text-text-primary">₹{plan.monthlyFeeInr.toLocaleString("en-IN")}<span className="text-sm font-normal text-text-secondary"> /month</span></p>
            <Button className="mt-6 w-full" disabled={busy} onClick={() => choose(plan.id)}>
              {busy ? "Starting…" : "Select"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the error page**

```typescript
// src/pages/shopify-app-error.tsx
import * as React from "react";
import { useSearchParams } from "react-router-dom";

export default function ShopifyAppError() {
  const [params] = useSearchParams();
  const message = params.get("message") ?? "Something went wrong connecting your store.";
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="max-w-sm rounded-[var(--radius-lg)] border border-border bg-surface p-6 text-center">
        <p className="text-[13px] text-negative">{message}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the routes**

In `src/App.tsx`, add both as public routes (outside `RequireAuth`, same placement as `/pricing`):
```typescript
const ShopifyAppPlans = lazy(() => import("@/pages/shopify-app-plans"));
const ShopifyAppError = lazy(() => import("@/pages/shopify-app-error"));
...
<Route path="/shopify-app/plans" element={<ShopifyAppPlans />} />
<Route path="/shopify-app/error" element={<ShopifyAppError />} />
```

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: builds clean, zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/shopify-app-plans.tsx src/pages/shopify-app-error.tsx src/App.tsx
git commit -m "feat(frontend): add the Shopify App Store plan picker and error pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Env documentation and final verification

**Files:**
- Modify: `server/.env.example`

**Interfaces:** None — documentation and verification only.

- [ ] **Step 1: Document the new env vars**

Add to `server/.env.example`, near the existing `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` section:

```
# Shopify App Store app — a SEPARATE Shopify Partner app from the one above
# (SHOPIFY_API_KEY/SECRET), registered with Distribution: Shopify App Store in
# partners.shopify.com. Keeping it separate means this public listing's app-review
# requirements never touch the existing agency-connect flow's app.
SHOPIFY_APP_STORE_CLIENT_ID=replace-with-app-store-partner-app-client-id
SHOPIFY_APP_STORE_CLIENT_SECRET=replace-with-app-store-partner-app-client-secret
```

- [ ] **Step 2: Run the whole server suite and type-check**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: type-check clean; every test file passes.

- [ ] **Step 3: Frontend build**

Run: `npm run build`
Expected: succeeds, zero TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add server/.env.example
git commit -m "docs(server): document SHOPIFY_APP_STORE_CLIENT_ID/_SECRET

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Write the real-account / manual checklist into your report**

This plan cannot be fully verified without a real Shopify Partner app and a real dev
store. Write this checklist into your final report verbatim, and be explicit about which
items were NOT performed:

1. Register a new Shopify Partner app (Distribution: Shopify App Store), confirm the
   exact GraphQL `appSubscriptionCreate`/`AppSubscriptionLineItemInput` field names and
   currency behavior against Shopify's current docs (the "Known uncertainties" section
   at the top of this plan) — correct Task 4's code if anything drifted.
2. Set `SHOPIFY_APP_STORE_CLIENT_ID`/`_SECRET` in a real environment, install on a real
   development store, confirm the full flow end to end: install → OAuth approval →
   provisioning → plan picker → Shopify's real charge-approval screen → billing-callback
   → landing in the real dashboard already logged in.
3. Register the 4 mandatory webhooks (`customers/data_request`, `customers/redact`,
   `shop/redact`, `app_subscriptions/update`) in the Partner Dashboard pointing at this
   app's deployed URLs, and confirm Shopify's own webhook test/delivery tooling reports
   200s.
4. Submit for Shopify's protected customer data access review (flagged in the spec as a
   likely-required separate approval gate) before submitting the listing for general app
   review.
5. Confirm uninstalling the app in a test store triggers `shop/redact` and the client's
   data is actually removed.
