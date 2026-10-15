# Self-Serve SaaS Signup & Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dashboard into a self-serve product: a public pricing page, a Razorpay-backed signup flow, pay-then-provision account creation, and real recurring billing.

**Architecture:** One app, new public routes on the existing Express backend and React frontend. Nothing is created in the database until Razorpay's payment signature is verified server-side; provisioning (Supabase user, `clients`/`team_members`/`team_member_clients`/`subscriptions`/`invoices` rows) happens atomically in one transaction right after.

**Tech Stack:** Express, `pg`, React, React Router, Razorpay's REST API (hand-rolled via `fetch`, no SDK — matching every existing integration in this codebase), Supabase Auth Admin REST API (hand-rolled via `fetch`, no `@supabase/supabase-js` added server-side).

**Spec:** `docs/superpowers/specs/2026-10-15-saas-signup-billing-design.md`

## Global Constraints

- No new npm dependencies for Razorpay or Supabase Admin — every existing third-party integration (Shopify, Meta, Google Ads, Shiprocket, Delhivery) in this codebase is hand-rolled via raw `fetch()`, not an SDK. Stay consistent.
- Pay-then-provision: nothing is inserted into `clients`/`team_members`/`team_member_clients`/`subscriptions`/`invoices` until the server has independently verified Razorpay's payment signature.
- `POST /api/signup` only ever accepts `planId` of `"small"`, `"medium"`, or `"large"` — `"enterprise"` is always rejected with a 400 pointing at the Contact Us flow.
- All five new endpoints (`GET /api/plans`, `POST /api/signup`, `POST /api/signup/complete`, `POST /api/enterprise-leads`, `POST /api/webhooks/razorpay`) carry no `requireAuth` — they are genuinely public.
- The Razorpay webhook route is mounted in `server/src/index.ts` ahead of `app.use(express.json())`, with its own `express.raw()`, exactly like the existing `shopifyWebhooksRouter` mount — signature verification needs the raw body.
- Every self-serve `team_members` row gets `all_client_access = false` and exactly one `team_member_clients` row — self-serve owners only ever see their own client, using the identical scoping every existing scoped team member already relies on.

## Review Focus

- Two signups for the same brand name landing close together — client id collisions. (Task 2)
- A client-side retry (double-click, flaky network) resubmitting `/api/signup/complete` after it already succeeded once — must not create a second client for the same payment. (Task 9)
- Razorpay redelivering the same webhook event (standard webhook behavior, not an edge case) — must not duplicate invoice rows or corrupt subscription state. (Task 10)
- Signing up with an email that's already a `team_members` row (self-serve or agency-created) — must be rejected before any payment or provisioning side effect, not fail halfway through. (Task 9)
- Supabase user creation succeeding but a later DB insert failing — must not leave an orphaned Auth user with no corresponding app access. (Task 9)

---

### Task 1: Schema migration

**Files:**
- Create: `server/migrations/013_saas_billing.sql`
- Test: `server/test/migration-013.test.ts`

**Interfaces:**
- Produces: `plans.extra_meta_account_price_inr`, `plans.extra_google_account_price_inr`, `plans.extra_shopify_store_price_inr` (integer columns); `subscriptions.gateway_subscription_id` (renamed from `gateway_customer_id`); `enterprise_leads` table (`id`, `name`, `email`, `company`, `estimated_orders_per_month`, `message`, `created_at`).

- [ ] **Step 1: Write the migration**

```sql
-- server/migrations/013_saas_billing.sql
-- Add-on prices (flat across tiers today per the pricing screenshots, but stored
-- per-plan so tiered add-on pricing is possible later without a schema change).
alter table plans add column extra_meta_account_price_inr integer;
alter table plans add column extra_google_account_price_inr integer;
alter table plans add column extra_shopify_store_price_inr integer;

update plans set
  extra_meta_account_price_inr = 499,
  extra_google_account_price_inr = 499,
  extra_shopify_store_price_inr = 999
where id in ('small', 'medium', 'large', 'enterprise');

-- This column has always stored Razorpay's *subscription* reference, not a
-- customer reference — the name was a misnomer from when this table was first
-- scaffolded. Renamed while this table is already being wired to a real gateway.
alter table subscriptions rename column gateway_customer_id to gateway_subscription_id;

-- Enterprise "Contact us" lead capture. No email-sending infrastructure exists
-- anywhere in this app yet, so storing leads is simpler and more reliable than
-- adding one.
create table enterprise_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text not null,
  estimated_orders_per_month integer,
  message text,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Write the migration test**

```typescript
// server/test/migration-013.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
});

describe("migration 013 (SaaS billing schema)", () => {
  it("seeds add-on prices on every existing plan", async () => {
    const res = await testPool.query(
      "select id, extra_meta_account_price_inr, extra_google_account_price_inr, extra_shopify_store_price_inr from plans order by id",
    );
    expect(res.rows).toEqual([
      { id: "enterprise", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
      { id: "large", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
      { id: "medium", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
      { id: "small", extra_meta_account_price_inr: 499, extra_google_account_price_inr: 499, extra_shopify_store_price_inr: 999 },
    ]);
  });

  it("renamed gateway_customer_id to gateway_subscription_id on subscriptions", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values
       ('abc-fashion', 'small', 'active', 'sub_test123')`,
    );
    const res = await testPool.query("select gateway_subscription_id from subscriptions where client_id = 'abc-fashion'");
    expect(res.rows[0].gateway_subscription_id).toBe("sub_test123");
  });

  it("stores an enterprise lead", async () => {
    await testPool.query(
      `insert into enterprise_leads (name, email, company, estimated_orders_per_month, message) values
       ('Riya Kapoor', 'riya@bigbrand.com', 'Big Brand Co', 8000, 'Need a custom plan')`,
    );
    const res = await testPool.query("select name, email, company, estimated_orders_per_month, message from enterprise_leads");
    expect(res.rows).toEqual([
      { name: "Riya Kapoor", email: "riya@bigbrand.com", company: "Big Brand Co", estimated_orders_per_month: 8000, message: "Need a custom plan" },
    ]);
  });

  it("allows a null estimated_orders_per_month and message", async () => {
    await testPool.query(`insert into enterprise_leads (name, email, company) values ('Amit Rao', 'amit@brand.com', 'Brand Co')`);
    const res = await testPool.query("select estimated_orders_per_month, message from enterprise_leads");
    expect(res.rows[0]).toEqual({ estimated_orders_per_month: null, message: null });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/migration-013.test.ts`
Expected: FAIL — `column "extra_meta_account_price_inr" does not exist` (the migration hasn't run yet against the test DB's migration list).

- [ ] **Step 4: Run the test to verify it passes**

`resetTestDb()` re-applies every migration file in `server/migrations/` from scratch on each test run (see `server/test/helpers/test-db.ts`), so simply having the file in place is enough — no manual `npm run migrate up` needed for tests.

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/migration-013.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/migrations/013_saas_billing.sql server/test/migration-013.test.ts
git commit -m "feat(server): add SaaS billing schema (add-on prices, enterprise_leads, gateway_subscription_id rename)"
```

---

### Task 2: Extract the shared client-id/slug helper

**Files:**
- Create: `server/src/lib/slug.ts`
- Modify: `server/src/routes/clients.ts` (remove the now-duplicated `slugify`/`pickLogoColor`/`generateUniqueClientId`/`LOGO_COLORS`, import from the new module)
- Test: `server/test/lib/slug.test.ts`

**Interfaces:**
- Produces: `slugify(name: string): string`, `pickLogoColor(seed: string): string`, `generateUniqueClientId(pool: pg.Pool, name: string): Promise<string>` — all exported from `server/src/lib/slug.ts`. Task 9 (signup provisioning) imports `pickLogoColor` and `generateUniqueClientId` from here.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/lib/slug.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { slugify, pickLogoColor, generateUniqueClientId } from "../../src/lib/slug.js";

beforeEach(async () => {
  await resetTestDb();
});

describe("slugify", () => {
  it("lowercases, trims, and hyphenates", () => {
    expect(slugify("  ABC Fashion  ")).toBe("abc-fashion");
  });

  it("falls back to 'client' for a name with no alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("client");
  });
});

describe("pickLogoColor", () => {
  it("is deterministic for the same seed", () => {
    expect(pickLogoColor("abc-fashion")).toBe(pickLogoColor("abc-fashion"));
  });
});

describe("generateUniqueClientId", () => {
  it("returns the plain slug when it's not taken", async () => {
    const id = await generateUniqueClientId(testPool, "ABC Fashion");
    expect(id).toBe("abc-fashion");
  });

  it("appends an incrementing suffix when the slug collides, including a second collision", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A'),
       ('abc-fashion-2', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    const id = await generateUniqueClientId(testPool, "ABC Fashion");
    expect(id).toBe("abc-fashion-3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/slug.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/slug.js'`

- [ ] **Step 3: Write the module**

```typescript
// server/src/lib/slug.ts
import type pg from "pg";

const LOGO_COLORS = [
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-emerald-500",
  "bg-blue-500",
  "bg-pink-500",
  "bg-amber-500",
];

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "client";
}

export function pickLogoColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LOGO_COLORS[hash % LOGO_COLORS.length];
}

export async function generateUniqueClientId(pool: pg.Pool, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while ((await pool.query("select 1 from clients where id = $1", [candidate])).rowCount! > 0) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}
```

- [ ] **Step 4: Update clients.ts to use the shared module**

Read `server/src/routes/clients.ts` first. Remove its local `LOGO_COLORS` array, `pickLogoColor`, `slugify`, and `generateUniqueClientId` function definitions. Add the import, and update the two call sites (`POST /` and nowhere else) to call `generateUniqueClientId(pool, name)` instead of `generateUniqueClientId(name)`:

```typescript
import { slugify, pickLogoColor, generateUniqueClientId } from "../lib/slug.js";
```

The two existing call sites in `clients.ts` (`const id = await generateUniqueClientId(name);` and `const logoColor = pickLogoColor(id);`) change only the first one, to pass `pool` as the first argument: `const id = await generateUniqueClientId(pool, name);`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/slug.test.ts test/routes/clients.test.ts`
Expected: PASS (all tests in both files — `clients.test.ts`'s existing `POST /api/clients` tests must still pass unchanged, since the behavior is identical, just relocated)

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/slug.ts server/src/routes/clients.ts server/test/lib/slug.test.ts
git commit -m "refactor(server): extract client-id slug helper, shared by clients.ts and the new signup route"
```

---

### Task 3: IP-scoped rate limiting

**Files:**
- Modify: `server/src/middleware/rate-limit.ts`
- Test: `server/test/middleware/rate-limit.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createRateLimiter({ ..., scope: "ip" })` — a third scope option, keyed by the request's IP address instead of `req.auth.userId`. Tasks 8 and 11 both use `scope: "ip"` on public endpoints where `req.auth` doesn't exist.

- [ ] **Step 1: Write the failing test**

Read `server/test/middleware/rate-limit.test.ts` first to match its existing test style (it builds a bare Express app with the middleware mounted and issues requests via `supertest`).

Add this test to that file:

```typescript
it("scope 'ip' keys by request IP instead of req.auth.userId, so it works on public routes with no auth", async () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 60_000, scope: "ip" });
  const app = express();
  app.use(limiter);
  app.get("/", (_req, res) => res.json({ ok: true }));

  // supertest requests from the same agent share the same source IP (127.0.0.1),
  // so three requests in a row should trip the limit on the third.
  await request(app).get("/").expect(200);
  await request(app).get("/").expect(200);
  const third = await request(app).get("/");
  expect(third.status).toBe(429);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/middleware/rate-limit.test.ts`
Expected: FAIL — `scope` type doesn't accept `"ip"`, or the limiter doesn't trip (still keying by the shared `"anon"` bucket, which would actually also trip at 2 — read the existing test file first to confirm the real failure mode before writing the fix, since the "anon" fallback might coincidentally pass this specific test; the real bug is that `"user-and-client"` and `"user"` scopes both collapse to the same key for every unauthenticated caller, which the next step's `scope: "ip"` branch fixes explicitly)

- [ ] **Step 3: Add the IP scope**

Read `server/src/middleware/rate-limit.ts` first. Change the `scope` parameter's type and the key derivation:

```typescript
scope = "user-and-client",
```
becomes part of a union that includes `"ip"`:
```typescript
scope?: "user" | "user-and-client" | "ip";
```

And the key derivation line:
```typescript
const userId = req.auth?.userId ?? "anon";
const key = scope === "user" ? userId : `${userId}:${req.params.id ?? ""}`;
```
becomes:
```typescript
const key =
  scope === "ip"
    ? (req.ip ?? "unknown-ip")
    : scope === "user"
      ? (req.auth?.userId ?? "anon")
      : `${req.auth?.userId ?? "anon"}:${req.params.id ?? ""}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/middleware/rate-limit.test.ts`
Expected: PASS (all tests, including the existing `"user"`/`"user-and-client"` ones, unchanged)

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/rate-limit.ts server/test/middleware/rate-limit.test.ts
git commit -m "feat(server): add an IP-scoped rate limiter mode for public, unauthenticated endpoints"
```

---

### Task 4: Public plans endpoint

**Files:**
- Create: `server/src/routes/public-plans.ts`
- Modify: `server/src/index.ts` (mount it)
- Test: `server/test/routes/public-plans.test.ts`

**Interfaces:**
- Produces: `GET /api/plans` — no auth required. Response: `{ id, name, orderLimit, monthlyFeeInr, includedMetaAccounts, includedGoogleAccounts, extraMetaAccountPriceInr, extraGoogleAccountPriceInr, extraShopifyStorePriceInr }[]`, ordered by `monthly_fee_inr`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/routes/public-plans.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { resetTestDb } from "../helpers/test-db.js";

describe("GET /api/plans", () => {
  it("returns every seeded plan with no authentication required", async () => {
    await resetTestDb();
    const res = await request(app).get("/api/plans");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const small = res.body.find((p: { id: string }) => p.id === "small");
    expect(small).toMatchObject({
      id: "small",
      name: "Small",
      orderLimit: 300,
      monthlyFeeInr: 1499,
      includedMetaAccounts: 1,
      includedGoogleAccounts: 1,
      extraMetaAccountPriceInr: 499,
      extraGoogleAccountPriceInr: 499,
      extraShopifyStorePriceInr: 999,
    });
  });

  it("orders plans by monthly fee, cheapest first", async () => {
    await resetTestDb();
    const res = await request(app).get("/api/plans");
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(["small", "medium", "large", "enterprise"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/public-plans.test.ts`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the route**

```typescript
// server/src/routes/public-plans.ts
import { Router } from "express";
import pool from "../db.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const result = await pool.query("select * from plans order by monthly_fee_inr");
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        orderLimit: r.order_limit,
        monthlyFeeInr: r.monthly_fee_inr,
        includedMetaAccounts: r.included_meta_accounts,
        includedGoogleAccounts: r.included_google_accounts,
        extraMetaAccountPriceInr: r.extra_meta_account_price_inr,
        extraGoogleAccountPriceInr: r.extra_google_account_price_inr,
        extraShopifyStorePriceInr: r.extra_shopify_store_price_inr,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router**

Read `server/src/index.ts` first. Add the import alongside the other route imports:
```typescript
import publicPlansRouter from "./routes/public-plans.js";
```
And mount it alongside the other `/api/...` mounts (anywhere after `app.use(express.json())`, order doesn't matter relative to the authenticated routers since this path doesn't overlap any of them):
```typescript
app.use("/api/plans", publicPlansRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/public-plans.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/public-plans.ts server/src/index.ts server/test/routes/public-plans.test.ts
git commit -m "feat(server): add a public GET /api/plans endpoint for the pricing page"
```

---

### Task 5: Razorpay API wrapper

**Files:**
- Create: `server/src/integrations/razorpay-api.ts`
- Test: `server/test/integrations/razorpay-api.test.ts`
- Modify: `server/.env.example`

**Interfaces:**
- Produces:
  - `createSubscription(planId: "small" | "medium" | "large"): Promise<{ id: string }>`
  - `verifySubscriptionPaymentSignature(params: { razorpayPaymentId: string; razorpaySubscriptionId: string; razorpaySignature: string }): boolean`
  - `verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean`
  - `getRazorpayKeyId(): string` (the publishable key id, returned to the frontend to open Checkout — distinct from the secret key, which never leaves the server)

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/integrations/razorpay-api.test.ts
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSubscription,
  verifySubscriptionPaymentSignature,
  verifyWebhookSignature,
  getRazorpayKeyId,
} from "../../src/integrations/razorpay-api.js";

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.RAZORPAY_PLAN_ID_SMALL = "plan_small123";
  process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
  process.env.RAZORPAY_PLAN_ID_LARGE = "plan_large123";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSubscription", () => {
  it("creates a Razorpay subscription against the plan's mapped Razorpay Plan ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
        expect(init?.headers).toMatchObject({ Authorization: expect.stringContaining("Basic ") });
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({ plan_id: "plan_medium123", customer_notify: 1 });
        expect(body.total_count).toBeGreaterThan(0);
        return new Response(JSON.stringify({ id: "sub_abc123", status: "created" }), { status: 200 });
      }),
    );
    const result = await createSubscription("medium");
    expect(result).toEqual({ id: "sub_abc123" });
  });

  it("throws if Razorpay rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { description: "bad plan" } }), { status: 400 })));
    await expect(createSubscription("small")).rejects.toThrow(/Razorpay subscription creation failed/);
  });
});

describe("verifySubscriptionPaymentSignature", () => {
  it("accepts a correctly computed signature", () => {
    const paymentId = "pay_xyz789";
    const subscriptionId = "sub_abc123";
    const signature = crypto.createHmac("sha256", "test-key-secret").update(`${paymentId}|${subscriptionId}`).digest("hex");
    expect(
      verifySubscriptionPaymentSignature({ razorpayPaymentId: paymentId, razorpaySubscriptionId: subscriptionId, razorpaySignature: signature }),
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    expect(
      verifySubscriptionPaymentSignature({ razorpayPaymentId: "pay_xyz789", razorpaySubscriptionId: "sub_abc123", razorpaySignature: "0".repeat(64) }),
    ).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed raw body", () => {
    const body = Buffer.from(JSON.stringify({ event: "subscription.charged" }));
    const signature = crypto.createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(Buffer.from("{}"), undefined)).toBe(false);
  });
});

describe("getRazorpayKeyId", () => {
  it("returns the configured key id", () => {
    expect(getRazorpayKeyId()).toBe("rzp_test_key123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/integrations/razorpay-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/integrations/razorpay-api.js'`

- [ ] **Step 3: Write the module**

```typescript
// server/src/integrations/razorpay-api.ts
import crypto from "node:crypto";

// A monthly subscription with no planned end date still needs a total_count —
// Razorpay has no literal "forever" option. 1200 cycles (100 years) is the
// conventional way to express "runs until explicitly cancelled".
const INDEFINITE_TOTAL_COUNT = 1200;

function getCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables must be set");
  }
  return { keyId, keySecret };
}

export function getRazorpayKeyId(): string {
  return getCredentials().keyId;
}

function getPlanId(planId: "small" | "medium" | "large"): string {
  const envVar = { small: "RAZORPAY_PLAN_ID_SMALL", medium: "RAZORPAY_PLAN_ID_MEDIUM", large: "RAZORPAY_PLAN_ID_LARGE" }[planId];
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`${envVar} environment variable must be set — create the matching recurring Plan in Razorpay's dashboard first`);
  }
  return value;
}

export async function createSubscription(planId: "small" | "medium" | "large"): Promise<{ id: string }> {
  const { keyId, keySecret } = getCredentials();
  const res = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify({ plan_id: getPlanId(planId), customer_notify: 1, total_count: INDEFINITE_TOTAL_COUNT }),
  });
  if (!res.ok) {
    throw new Error(`Razorpay subscription creation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

// Razorpay's documented formula for verifying a subscription payment: HMAC-SHA256 of
// "<payment_id>|<subscription_id>" keyed with the API secret, hex-encoded, timing-safe
// compared against the signature the client received from Razorpay's own Checkout.
export function verifySubscriptionPaymentSignature(params: {
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}): boolean {
  const { keySecret } = getCredentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${params.razorpayPaymentId}|${params.razorpaySubscriptionId}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(params.razorpaySignature, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Razorpay's documented webhook scheme: HMAC-SHA256 of the raw request body, keyed with
// the webhook secret configured when the webhook was registered in Razorpay's dashboard
// (separate from the API key secret above).
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET environment variable must be set");
  }
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}
```

- [ ] **Step 4: Document the new env vars**

Read `server/.env.example` first, then append:

```
# Razorpay — razorpay.com dashboard → Settings → API Keys (key id/secret) and
# Settings → Webhooks (webhook secret, after registering
# PUBLIC_API_URL + /api/webhooks/razorpay with the subscription.charged,
# subscription.halted, and subscription.cancelled events).
RAZORPAY_KEY_ID=replace-with-your-key-id
RAZORPAY_KEY_SECRET=replace-with-your-key-secret
RAZORPAY_WEBHOOK_SECRET=replace-with-your-webhook-secret
# Create one recurring monthly Plan per self-serve tier in Razorpay's dashboard
# (Settings > Plans) matching plans.monthly_fee_inr for small/medium/large —
# Enterprise has no Razorpay Plan, it's Contact Us only — then paste each Plan's id here.
RAZORPAY_PLAN_ID_SMALL=replace-with-plan-id
RAZORPAY_PLAN_ID_MEDIUM=replace-with-plan-id
RAZORPAY_PLAN_ID_LARGE=replace-with-plan-id
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/integrations/razorpay-api.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/razorpay-api.ts server/test/integrations/razorpay-api.test.ts server/.env.example
git commit -m "feat(server): add a hand-rolled Razorpay API wrapper (subscriptions, signature verification)"
```

---

### Task 6: Real Razorpay payment gateway, wired into billing.ts

**Files:**
- Modify: `server/src/integrations/payment-gateway.ts`
- Modify: `server/src/routes/billing.ts`
- Test: `server/test/integrations/payment-gateway.test.ts`
- Test: `server/test/routes/billing.test.ts` (update, if it asserts on the stub's console.log behavior — read it first)

**Interfaces:**
- Consumes: `createSubscription` from Task 5 (`server/src/integrations/razorpay-api.js`).
- Produces: `razorpayGateway: PaymentGateway`, exported alongside the existing `stubPaymentGateway` (don't delete the stub — it stays available for any future non-Razorpay gateway or local dev without Razorpay credentials; `billing.ts` is what switches which one it imports).

- [ ] **Step 1: Read the existing files first**

Read `server/src/integrations/payment-gateway.ts` and `server/src/routes/billing.ts` in full, and `server/test/routes/billing.test.ts` to see exactly what it currently asserts about the stub (it may assert on the literal `[stub payment gateway] would create subscription for...` console output, per this session's compaction summary — if so, those specific assertions need to change to match the real gateway's behavior instead).

- [ ] **Step 2: Write the failing test**

```typescript
// server/test/integrations/payment-gateway.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { razorpayGateway } from "../../src/integrations/payment-gateway.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("razorpayGateway.createSubscription", () => {
  it("creates a real Razorpay subscription and returns its id as the gateway customer id", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
    process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
    process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sub_abc123" }), { status: 200 })));

    const result = await razorpayGateway.createSubscription("abc-fashion", "medium");
    expect(result).toEqual({ gatewayCustomerId: "sub_abc123" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/integrations/payment-gateway.test.ts`
Expected: FAIL — `razorpayGateway` is not exported

- [ ] **Step 4: Add the real gateway**

Add to `server/src/integrations/payment-gateway.ts`, alongside the existing `stubPaymentGateway` (keep that export as-is):

```typescript
import { createSubscription } from "./razorpay-api.js";

export const razorpayGateway: PaymentGateway = {
  async createSubscription(_clientId, planId) {
    if (planId !== "small" && planId !== "medium" && planId !== "large") {
      throw new Error(`No Razorpay Plan is configured for plan id "${planId}" — only small/medium/large have one`);
    }
    const { id } = await createSubscription(planId);
    return { gatewayCustomerId: id };
  },
  async chargeInvoice(_invoiceId) {
    // Razorpay charges recurring invoices itself on its own billing cycle — this app
    // never initiates a charge directly, it only reacts to the subscription.charged
    // webhook (Task 10). Nothing to do here; kept to satisfy the PaymentGateway interface.
    return { status: "paid" };
  },
  async cancelSubscription(_subscriptionId) {
    // Not needed for this plan's scope (plan changes/cancellation are explicitly out of
    // scope per the spec) — left unimplemented rather than guessed at.
    throw new Error("razorpayGateway.cancelSubscription is not implemented yet");
  },
};
```

- [ ] **Step 5: Wire billing.ts to the real gateway**

In `server/src/routes/billing.ts`, change the import from `stubPaymentGateway` to `razorpayGateway`, and update the one call site (`stubPaymentGateway.createSubscription(...)`) to `razorpayGateway.createSubscription(...)`.

- [ ] **Step 6: Update billing.test.ts if needed**

If `server/test/routes/billing.test.ts` asserted on the stub's specific `console.log` text or its `gatewayCustomerId: null` return value, update those tests to instead stub `fetch` the same way `payment-gateway.test.ts` does (Razorpay credentials in `process.env`, a mocked `fetch` returning `{ id: "sub_..." }`), and assert the real `gatewayCustomerId` comes back populated, not null.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/integrations/payment-gateway.test.ts test/routes/billing.test.ts`
Expected: PASS (all tests)

- [ ] **Step 8: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 9: Commit**

```bash
git add server/src/integrations/payment-gateway.ts server/src/routes/billing.ts server/test/integrations/payment-gateway.test.ts server/test/routes/billing.test.ts
git commit -m "feat(server): wire a real Razorpay payment gateway into billing.ts, replacing the stub"
```

---

### Task 7: Supabase Admin client wrapper

**Files:**
- Create: `server/src/lib/supabase-admin.ts`
- Test: `server/test/lib/supabase-admin.test.ts`
- Modify: `server/.env.example`

**Interfaces:**
- Produces:
  - `createSupabaseUser(email: string, password: string): Promise<{ id: string }>` — throws `EmailAlreadyRegisteredError` (a new exported class) if Supabase reports the email is already in use, a generic `Error` for any other failure.
  - `deleteSupabaseUser(userId: string): Promise<void>` — the compensating action if provisioning fails after the Supabase user was created. Logs (does not throw) if the delete itself fails, since this already runs inside an error-handling path and must not mask the original error.
  - `EmailAlreadyRegisteredError` (exported class extending `Error`).

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/lib/supabase-admin.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSupabaseUser, deleteSupabaseUser, EmailAlreadyRegisteredError } from "../../src/lib/supabase-admin.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSupabaseUser", () => {
  it("creates a confirmed user and returns its id", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://test-project.supabase.co/auth/v1/admin/users");
        expect(init?.headers).toMatchObject({ apikey: "test-service-role-key", Authorization: "Bearer test-service-role-key" });
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({ email: "riya@newbrand.com", password: "a-real-password", email_confirm: true });
        return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }), { status: 200 });
      }),
    );
    const result = await createSupabaseUser("riya@newbrand.com", "a-real-password");
    expect(result).toEqual({ id: "11111111-1111-1111-1111-111111111111" });
  });

  it("throws EmailAlreadyRegisteredError when Supabase reports a duplicate email", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 })),
    );
    await expect(createSupabaseUser("riya@newbrand.com", "a-real-password")).rejects.toThrow(EmailAlreadyRegisteredError);
  });

  it("throws a generic error for any other failure", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ msg: "internal error" }), { status: 500 })));
    await expect(createSupabaseUser("riya@newbrand.com", "a-real-password")).rejects.toThrow(/Supabase user creation failed/);
  });
});

describe("deleteSupabaseUser", () => {
  it("calls the admin delete endpoint", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://test-project.supabase.co/auth/v1/admin/users/11111111-1111-1111-1111-111111111111");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await deleteSupabaseUser("11111111-1111-1111-1111-111111111111");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not throw if the delete itself fails (would mask the original provisioning error)", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(deleteSupabaseUser("11111111-1111-1111-1111-111111111111")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/supabase-admin.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/supabase-admin.js'`

- [ ] **Step 3: Write the module**

```typescript
// server/src/lib/supabase-admin.ts
export class EmailAlreadyRegisteredError extends Error {}

function getCredentials(): { url: string; serviceRoleKey: string } {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables must be set");
  }
  return { url, serviceRoleKey };
}

export async function createSupabaseUser(email: string, password: string): Promise<{ id: string }> {
  const { url, serviceRoleKey } = getCredentials();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (res.status === 422) {
    throw new EmailAlreadyRegisteredError("This email is already registered. Log in instead.");
  }
  if (!res.ok) {
    throw new Error(`Supabase user creation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

export async function deleteSupabaseUser(userId: string): Promise<void> {
  try {
    const { url, serviceRoleKey } = getCredentials();
    await fetch(`${url}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
  } catch (err) {
    // Swallowed deliberately: this only ever runs as a compensating action after a
    // provisioning failure, inside a catch block. Throwing here would replace the real
    // error with a less useful one about cleanup failing.
    console.error(`Failed to delete orphaned Supabase user ${userId} during signup rollback:`, err);
  }
}
```

- [ ] **Step 4: Document the new env var**

Read `server/.env.example` first (it already documents `SUPABASE_SERVICE_ROLE_KEY` for a different purpose — confirm its existing comment, and only add a note if the admin-API usage isn't already implied). If `SUPABASE_SERVICE_ROLE_KEY` is already present, no change needed here; this module reuses that existing variable rather than introducing a new one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/supabase-admin.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/supabase-admin.ts server/test/lib/supabase-admin.test.ts
git commit -m "feat(server): add a hand-rolled Supabase Auth Admin API wrapper for self-serve signup"
```

---

### Task 8: POST /api/signup

**Files:**
- Create: `server/src/routes/signup.ts`
- Modify: `server/src/index.ts` (mount it)
- Test: `server/test/routes/signup.test.ts`

**Interfaces:**
- Consumes: `createSubscription`/`getRazorpayKeyId` are NOT called directly here — this task calls the gateway via `razorpayGateway` is for an *existing* client (Task 6's shape takes `clientId`, which doesn't exist yet at this point in the flow) — so this task calls `createSubscription` from Task 5's `razorpay-api.js` directly, not through the `PaymentGateway` interface. `createRateLimiter` from Task 3 (`scope: "ip"`).
- Produces: `POST /api/signup`, exported as the default router from `server/src/routes/signup.ts`. Task 9 adds the `/complete` route to this same file/router.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/routes/signup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { resetTestDb } from "../helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.RAZORPAY_KEY_ID = "rzp_test_key123";
  process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
  process.env.RAZORPAY_PLAN_ID_SMALL = "plan_small123";
  process.env.RAZORPAY_PLAN_ID_MEDIUM = "plan_medium123";
  process.env.RAZORPAY_PLAN_ID_LARGE = "plan_large123";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/signup", () => {
  it("creates a Razorpay subscription and returns its id plus the publishable key, with no auth required", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sub_abc123" }), { status: 200 })));
    const res = await request(app).post("/api/signup").send({ planId: "medium" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ razorpaySubscriptionId: "sub_abc123", razorpayKeyId: "rzp_test_key123" });
  });

  it("rejects planId 'enterprise'", async () => {
    const res = await request(app).post("/api/signup").send({ planId: "enterprise" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("no_self_serve_enterprise");
  });

  it("rejects an unknown planId", async () => {
    const res = await request(app).post("/api/signup").send({ planId: "nonexistent" });
    expect(res.status).toBe(400);
  });

  it("400s a missing planId", async () => {
    const res = await request(app).post("/api/signup").send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/signup.test.ts`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the route**

```typescript
// server/src/routes/signup.ts
import { Router } from "express";
import { createSubscription, getRazorpayKeyId } from "../integrations/razorpay-api.js";
import { HttpError } from "../lib/http-error.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

const router = Router();

const SELF_SERVE_PLAN_IDS = ["small", "medium", "large"] as const;
type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];

function isSelfServePlanId(value: unknown): value is SelfServePlanId {
  return typeof value === "string" && (SELF_SERVE_PLAN_IDS as readonly string[]).includes(value);
}

router.post("/", createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, scope: "ip" }), async (req, res, next) => {
  try {
    const { planId } = req.body as { planId?: string };
    if (planId === "enterprise") {
      throw new HttpError(400, "no_self_serve_enterprise", "Enterprise plans are custom — use the Contact Us form instead.");
    }
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }
    const { id } = await createSubscription(planId);
    res.json({ razorpaySubscriptionId: id, razorpayKeyId: getRazorpayKeyId() });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, add the import and mount alongside the other public routers:
```typescript
import signupRouter from "./routes/signup.js";
...
app.use("/api/signup", signupRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/signup.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/signup.ts server/src/index.ts server/test/routes/signup.test.ts
git commit -m "feat(server): add POST /api/signup — creates the Razorpay subscription shell before any payment"
```

---

### Task 9: POST /api/signup/complete

**Files:**
- Modify: `server/src/routes/signup.ts` (add the `/complete` route to the same router)
- Test: `server/test/routes/signup.test.ts` (add to the same file)

**Interfaces:**
- Consumes: `verifySubscriptionPaymentSignature` (Task 5), `createSupabaseUser`/`deleteSupabaseUser`/`EmailAlreadyRegisteredError` (Task 7), `slugify`/`pickLogoColor`/`generateUniqueClientId` (Task 2).
- Produces: `POST /api/signup/complete` on the same router as Task 8.

This is the task the Review Focus items concentrate on — idempotent resubmission, duplicate email, and the orphaned-Supabase-user rollback all get their tests here.

- [ ] **Step 1: Write the failing tests**

Add `import crypto from "node:crypto";` to the top of `server/test/routes/signup.test.ts`'s existing import block (this codebase is ESM throughout — `require()` isn't available in a test file, matching how `test/integrations/shopify.test.ts` already imports it).

Add to `server/test/routes/signup.test.ts`:

```typescript
describe("POST /api/signup/complete", () => {
  const validBody = {
    razorpaySubscriptionId: "sub_abc123",
    razorpayPaymentId: "pay_xyz789",
    planId: "medium",
    brandName: "New Brand Co",
    category: "Fashion & Apparel",
    ownerName: "Riya Kapoor",
    email: "riya@newbrand.com",
    password: "a-real-password",
  };

  function signedBody(overrides: Partial<typeof validBody> = {}) {
    const body = { ...validBody, ...overrides };
    const razorpaySignature = crypto
      .createHmac("sha256", "test-key-secret")
      .update(`${body.razorpayPaymentId}|${body.razorpaySubscriptionId}`)
      .digest("hex");
    return { ...body, razorpaySignature };
  }

  function stubFetchForSuccessfulSupabaseCreate(userId = "11111111-1111-1111-1111-111111111111") {
    return vi.fn(async (url: string) => {
      if (url.includes("/auth/v1/admin/users")) {
        return new Response(JSON.stringify({ id: userId }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("provisions a client, team member, and subscription, and returns 200 on a valid payment", async () => {
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate());
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(200);

    const clients = await testPool.query("select id, name, category, owner_id from clients where name = 'New Brand Co'");
    expect(clients.rowCount).toBe(1);
    expect(clients.rows[0]).toMatchObject({ id: "new-brand-co", category: "Fashion & Apparel", owner_id: "11111111-1111-1111-1111-111111111111" });

    const teamMembers = await testPool.query("select id, name, email, role, all_client_access from team_members where email = 'riya@newbrand.com'");
    expect(teamMembers.rows[0]).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Riya Kapoor",
      role: "owner",
      all_client_access: false,
    });

    const scoping = await testPool.query("select client_id from team_member_clients where team_member_id = '11111111-1111-1111-1111-111111111111'");
    expect(scoping.rows).toEqual([{ client_id: "new-brand-co" }]);

    const subs = await testPool.query("select plan_id, status, gateway_subscription_id from subscriptions where client_id = 'new-brand-co'");
    expect(subs.rows[0]).toMatchObject({ plan_id: "medium", status: "active", gateway_subscription_id: "sub_abc123" });

    const invoices = await testPool.query(
      "select amount_inr, status from invoices where subscription_id = (select id from subscriptions where client_id = 'new-brand-co')",
    );
    expect(invoices.rows[0]).toMatchObject({ amount_inr: 2999, status: "paid" });
  });

  it("rejects an invalid payment signature and creates nothing", async () => {
    const res = await request(app).post("/api/signup/complete").send({ ...validBody, razorpaySignature: "0".repeat(64) });
    expect(res.status).toBe(400);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });

  it("rejects a duplicate email before touching the database", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 })),
    );
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(409);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });

  it("resubmitting the same already-completed signup does not create a second client", async () => {
    vi.stubGlobal("fetch", stubFetchForSuccessfulSupabaseCreate());
    await request(app).post("/api/signup/complete").send(signedBody());

    // Second attempt: Supabase now correctly reports the email as taken, since the first
    // request really did create it — this IS the idempotency guard, not a separate code path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 })),
    );
    const second = await request(app).post("/api/signup/complete").send(signedBody());
    expect(second.status).toBe(409);
    expect((await testPool.query("select count(*)::int as count from clients where name = 'New Brand Co'")).rows[0].count).toBe(1);
  });

  it("deletes the orphaned Supabase user if a later provisioning step fails", async () => {
    // Forces a DB failure after Supabase user creation but after the route's own field
    // validation already passed: a team_members row with this id already exists (it's
    // the mocked Supabase user id below), so the real insert hits a primary-key conflict.
    // A missing/invalid field would be rejected by validation before any Supabase call,
    // which wouldn't exercise this rollback path at all.
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Existing Member', 'existing@other.com', 'owner', false)`,
    );
    const deleteCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deleteCalls.push(url);
          return new Response(null, { status: 200 });
        }
        if (url.includes("/auth/v1/admin/users")) {
          return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const res = await request(app).post("/api/signup/complete").send(signedBody());
    expect(res.status).toBe(500);
    expect(deleteCalls).toEqual(["https://test-project.supabase.co/auth/v1/admin/users/11111111-1111-1111-1111-111111111111"]);
    expect((await testPool.query("select * from clients where name = 'New Brand Co'")).rowCount).toBe(0);
  });
});
```

Add `process.env.SUPABASE_URL = "https://test-project.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";` to the file's existing `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/signup.test.ts`
Expected: FAIL — 404, `/complete` route doesn't exist yet

- [ ] **Step 3: Write the route**

Add to `server/src/routes/signup.ts`:

```typescript
import pool from "../db.js";
import { verifySubscriptionPaymentSignature } from "../integrations/razorpay-api.js";
import { createSupabaseUser, deleteSupabaseUser, EmailAlreadyRegisteredError } from "../lib/supabase-admin.js";
import { slugify, pickLogoColor, generateUniqueClientId } from "../lib/slug.js";

interface SignupCompleteBody {
  razorpaySubscriptionId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  planId?: string;
  brandName?: string;
  category?: string;
  ownerName?: string;
  email?: string;
  password?: string;
}

router.post("/complete", createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, scope: "ip" }), async (req, res, next) => {
  try {
    const body = req.body as SignupCompleteBody;
    const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature, planId, brandName, category, ownerName, email, password } = body;

    if (!razorpaySubscriptionId || !razorpayPaymentId || !razorpaySignature) {
      throw new HttpError(400, "missing_payment_fields", "Missing Razorpay payment fields");
    }
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }
    if (!brandName?.trim() || !category?.trim() || !ownerName?.trim() || !email?.trim() || !password) {
      throw new HttpError(400, "missing_fields", "brandName, category, ownerName, email, and password are all required");
    }
    if (!verifySubscriptionPaymentSignature({ razorpayPaymentId, razorpaySubscriptionId, razorpaySignature })) {
      throw new HttpError(400, "invalid_signature", "Could not verify this payment with Razorpay");
    }

    let supabaseUserId: string;
    try {
      const user = await createSupabaseUser(email.trim(), password);
      supabaseUserId = user.id;
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        throw new HttpError(409, "email_already_registered", err.message);
      }
      throw err;
    }

    const planResult = await pool.query("select monthly_fee_inr from plans where id = $1", [planId]);
    const monthlyFeeInr = planResult.rows[0]?.monthly_fee_inr;

    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      const clientId = await generateUniqueClientId(pool, brandName.trim());
      const logoColor = pickLogoColor(clientId);
      const logoInitial = brandName.trim().charAt(0).toUpperCase();

      await dbClient.query(
        `insert into clients (id, name, category, logo_color, logo_initial, owner_id) values ($1, $2, $3, $4, $5, $6)`,
        [clientId, brandName.trim(), category.trim(), logoColor, logoInitial, supabaseUserId],
      );
      await dbClient.query(
        `insert into team_members (id, name, email, role, all_client_access) values ($1, $2, $3, 'owner', false)`,
        [supabaseUserId, ownerName.trim(), email.trim()],
      );
      await dbClient.query(`insert into team_member_clients (team_member_id, client_id) values ($1, $2)`, [supabaseUserId, clientId]);
      const subResult = await dbClient.query(
        `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values ($1, $2, 'active', $3) returning id`,
        [clientId, planId, razorpaySubscriptionId],
      );
      await dbClient.query(
        `insert into invoices (subscription_id, amount_inr, status, period_start, period_end)
         values ($1, $2, 'paid', now(), now() + interval '30 days')`,
        [subResult.rows[0].id, monthlyFeeInr],
      );
      await dbClient.query("COMMIT");
    } catch (err) {
      await dbClient.query("ROLLBACK");
      await deleteSupabaseUser(supabaseUserId);
      throw err;
    } finally {
      dbClient.release();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

Note: `slugify` is imported but not directly called in this snippet — `generateUniqueClientId` uses it internally. Remove the unused import if your editor flags it.

`generateUniqueClientId`'s uniqueness check (Task 2) runs against the shared `pool`, not the `dbClient` transaction connection, since the transaction hasn't inserted anything yet at the point it's called — two signups for the same brand name landing close together can both see the slug as free and then race on the final insert. This is acceptable: the second one's `clients` insert hits a primary-key conflict, which rolls back and deletes its orphaned Supabase user cleanly (exactly the path the next test below exercises), rather than silently corrupting data. The customer sees a failure and can retry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/signup.test.ts`
Expected: PASS (all tests, including the 6 new `/complete` ones)

- [ ] **Step 5: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/signup.ts server/test/routes/signup.test.ts
git commit -m "feat(server): add POST /api/signup/complete — verifies payment, then provisions the account atomically"
```

---

### Task 10: Razorpay webhook route

**Files:**
- Create: `server/src/routes/razorpay-webhooks.ts`
- Modify: `server/src/index.ts` (mount, raw-body, ahead of `express.json()`)
- Test: `server/test/routes/razorpay-webhooks.test.ts`

**Interfaces:**
- Consumes: `verifyWebhookSignature` (Task 5).
- Produces: `POST /api/webhooks/razorpay`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/routes/razorpay-webhooks.test.ts
import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

const WEBHOOK_SECRET = "test-webhook-secret";

function signWebhookBody(rawBody: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
}

function postWebhook(rawBody: string, signature?: string) {
  const req = request(app).post("/api/webhooks/razorpay").set("Content-Type", "application/json");
  if (signature !== undefined) req.set("X-Razorpay-Signature", signature);
  return req.send(rawBody);
}

beforeEach(async () => {
  await resetTestDb();
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into subscriptions (id, client_id, plan_id, status, gateway_subscription_id, current_period_start, current_period_end) values
     ('22222222-2222-2222-2222-222222222222', 'abc-fashion', 'medium', 'active', 'sub_abc123', now(), now() + interval '30 days')`,
  );
});

describe("POST /api/webhooks/razorpay", () => {
  it("subscription.charged updates the period and records a paid invoice", async () => {
    const rawBody = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_abc123", current_start: 1760000000, current_end: 1762592000 } },
        payment: { entity: { id: "pay_new123", amount: 299900 } },
      },
    });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);

    const sub = await testPool.query("select current_period_start, current_period_end from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(new Date(sub.rows[0].current_period_start).getTime()).toBe(1760000000 * 1000);

    const invoices = await testPool.query(
      "select amount_inr, status from invoices where subscription_id = '22222222-2222-2222-2222-222222222222' order by created_at desc limit 1",
    );
    expect(invoices.rows[0]).toMatchObject({ amount_inr: 2999, status: "paid" });
  });

  it("subscription.halted marks the subscription past_due", async () => {
    const rawBody = JSON.stringify({ event: "subscription.halted", payload: { subscription: { entity: { id: "sub_abc123" } } } });
    await postWebhook(rawBody, signWebhookBody(rawBody));
    const sub = await testPool.query("select status from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(sub.rows[0].status).toBe("past_due");
  });

  it("subscription.cancelled marks the subscription canceled", async () => {
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_abc123" } } } });
    await postWebhook(rawBody, signWebhookBody(rawBody));
    const sub = await testPool.query("select status from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(sub.rows[0].status).toBe("canceled");
  });

  it("redelivering the same subscription.charged event does not duplicate the invoice", async () => {
    const rawBody = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_abc123", current_start: 1760000000, current_end: 1762592000 } },
        payment: { entity: { id: "pay_new123", amount: 299900 } },
      },
    });
    await postWebhook(rawBody, signWebhookBody(rawBody));
    await postWebhook(rawBody, signWebhookBody(rawBody));
    const invoices = await testPool.query(
      "select count(*)::int as count from invoices where subscription_id = '22222222-2222-2222-2222-222222222222' and status = 'paid'",
    );
    // Exactly one invoice for this specific Razorpay payment id, not two — see Step 3's
    // razorpay_payment_id uniqueness note.
    expect(invoices.rows[0].count).toBe(1);
  });

  it("rejects an invalid signature", async () => {
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_abc123" } } } });
    const res = await postWebhook(rawBody, "0".repeat(64));
    expect(res.status).toBe(401);
    const sub = await testPool.query("select status from subscriptions where gateway_subscription_id = 'sub_abc123'");
    expect(sub.rows[0].status).toBe("active");
  });

  it("200s on an unrecognized event type without erroring", async () => {
    const rawBody = JSON.stringify({ event: "some.future.event", payload: {} });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);
  });

  it("200s for an unknown gateway_subscription_id (stale/test webhook) rather than erroring", async () => {
    const rawBody = JSON.stringify({ event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_unknown" } } } });
    const res = await postWebhook(rawBody, signWebhookBody(rawBody));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/razorpay-webhooks.test.ts`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the route**

```typescript
// server/src/routes/razorpay-webhooks.ts
import express, { Router } from "express";
import pool from "../db.js";
import { verifyWebhookSignature } from "../integrations/razorpay-api.js";

const router = Router();

router.use(express.raw({ type: "application/json" }));

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    subscription?: { entity: { id: string; current_start?: number; current_end?: number } };
    payment?: { entity: { id: string } };
  };
}

router.post("/", async (req, res, next) => {
  try {
    const rawBody = req.body as Buffer;
    if (!verifyWebhookSignature(rawBody, req.header("x-razorpay-signature"))) {
      res.status(401).send();
      return;
    }

    const event = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookPayload;
    const subscriptionId = event.payload.subscription?.entity.id;
    if (!subscriptionId) {
      res.status(200).send();
      return;
    }

    const subResult = await pool.query(
      "select id, client_id from subscriptions where gateway_subscription_id = $1",
      [subscriptionId],
    );
    if (subResult.rowCount === 0) {
      // Stale or test-mode webhook with no matching local subscription — nothing to do.
      res.status(200).send();
      return;
    }
    const { id: subscriptionRowId, client_id: clientId } = subResult.rows[0];

    if (event.event === "subscription.charged") {
      const entity = event.payload.subscription!.entity;
      const paymentId = event.payload.payment?.entity.id;
      if (entity.current_start && entity.current_end) {
        await pool.query(
          "update subscriptions set current_period_start = to_timestamp($1), current_period_end = to_timestamp($2), status = 'active' where id = $3",
          [entity.current_start, entity.current_end, subscriptionRowId],
        );
      }
      if (paymentId) {
        const planResult = await pool.query(
          "select p.monthly_fee_inr from subscriptions s join plans p on p.id = s.plan_id where s.id = $1",
          [subscriptionRowId],
        );
        // razorpay_payment_id is the natural idempotency key for a redelivered webhook —
        // if this exact payment was already recorded, this insert is a no-op rather than a
        // duplicate invoice. invoices has no column for it today; add one in this same task
        // rather than guessing at a workaround (see Step 3a below).
        await pool.query(
          `insert into invoices (subscription_id, amount_inr, status, period_start, period_end, razorpay_payment_id)
           values ($1, $2, 'paid', now(), now() + interval '30 days', $3)
           on conflict (razorpay_payment_id) do nothing`,
          [subscriptionRowId, planResult.rows[0]?.monthly_fee_inr, paymentId],
        );
      }
    } else if (event.event === "subscription.halted" || event.event === "payment.failed") {
      await pool.query("update subscriptions set status = 'past_due' where id = $1", [subscriptionRowId]);
    } else if (event.event === "subscription.cancelled") {
      await pool.query("update subscriptions set status = 'canceled' where id = $1", [subscriptionRowId]);
    }
    // Any other event type: 200, no-op — never fail on an event this app doesn't react to.

    void clientId; // reserved for a future per-client notification; not used yet.
    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 3a: Add the missing unique column migration**

Task 1's migration didn't anticipate needing a `razorpay_payment_id` column on `invoices` for idempotent webhook redelivery (discovered while implementing this task, not predictable until now). Add a second migration file rather than editing Task 1's already-committed one:

```sql
-- server/migrations/014_invoices_razorpay_payment_id.sql
-- Lets a redelivered subscription.charged webhook (standard Razorpay behavior, not an
-- edge case) be a no-op instead of recording a duplicate paid invoice.
alter table invoices add column razorpay_payment_id text unique;
```

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, add the import near `shopifyWebhooksRouter`'s:
```typescript
import razorpayWebhooksRouter from "./routes/razorpay-webhooks.js";
```
Mount it in the same raw-body-before-json() group as the Shopify webhook router:
```typescript
app.use("/api/webhooks/shopify", shopifyWebhooksRouter);
app.use("/api/webhooks/razorpay", razorpayWebhooksRouter);
app.use(express.json());
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/razorpay-webhooks.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/razorpay-webhooks.ts server/src/index.ts server/migrations/014_invoices_razorpay_payment_id.sql server/test/routes/razorpay-webhooks.test.ts
git commit -m "feat(server): add the real-time Razorpay webhook for subscription renewals/failures/cancellations"
```

---

### Task 11: Enterprise leads endpoint

**Files:**
- Create: `server/src/routes/enterprise-leads.ts`
- Modify: `server/src/index.ts` (mount it)
- Test: `server/test/routes/enterprise-leads.test.ts`

**Interfaces:**
- Consumes: `createRateLimiter` (Task 3).
- Produces: `POST /api/enterprise-leads`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/routes/enterprise-leads.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
});

describe("POST /api/enterprise-leads", () => {
  it("stores a lead with no authentication required", async () => {
    const res = await request(app)
      .post("/api/enterprise-leads")
      .send({ name: "Riya Kapoor", email: "riya@bigbrand.com", company: "Big Brand Co", estimatedOrdersPerMonth: 8000, message: "Need a custom plan" });
    expect(res.status).toBe(201);
    const rows = await testPool.query("select name, email, company, estimated_orders_per_month, message from enterprise_leads");
    expect(rows.rows).toEqual([
      { name: "Riya Kapoor", email: "riya@bigbrand.com", company: "Big Brand Co", estimated_orders_per_month: 8000, message: "Need a custom plan" },
    ]);
  });

  it("allows estimatedOrdersPerMonth and message to be omitted", async () => {
    const res = await request(app).post("/api/enterprise-leads").send({ name: "Amit Rao", email: "amit@brand.com", company: "Brand Co" });
    expect(res.status).toBe(201);
  });

  it("400s a missing required field", async () => {
    const res = await request(app).post("/api/enterprise-leads").send({ name: "Riya Kapoor", email: "riya@bigbrand.com" });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/enterprise-leads.test.ts`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the route**

```typescript
// server/src/routes/enterprise-leads.ts
import { Router } from "express";
import pool from "../db.js";
import { HttpError } from "../lib/http-error.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

const router = Router();

router.post("/", createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, scope: "ip" }), async (req, res, next) => {
  try {
    const { name, email, company, estimatedOrdersPerMonth, message } = req.body as {
      name?: string;
      email?: string;
      company?: string;
      estimatedOrdersPerMonth?: number;
      message?: string;
    };
    if (!name?.trim() || !email?.trim() || !company?.trim()) {
      throw new HttpError(400, "missing_fields", "name, email, and company are all required");
    }
    await pool.query(
      `insert into enterprise_leads (name, email, company, estimated_orders_per_month, message) values ($1, $2, $3, $4, $5)`,
      [name.trim(), email.trim(), company.trim(), estimatedOrdersPerMonth ?? null, message?.trim() || null],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`:
```typescript
import enterpriseLeadsRouter from "./routes/enterprise-leads.js";
...
app.use("/api/enterprise-leads", enterpriseLeadsRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/enterprise-leads.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/enterprise-leads.ts server/src/index.ts server/test/routes/enterprise-leads.test.ts
git commit -m "feat(server): add POST /api/enterprise-leads for the Contact Us form"
```

---

### Task 12: Frontend — public API helper + Pricing page

**Files:**
- Modify: `src/lib/api.ts` (add `publicApiFetch`)
- Create: `src/pages/pricing.tsx`
- Modify: `src/App.tsx` (add the `/pricing` route, outside `RequireAuth`)

**Interfaces:**
- Produces: `publicApiFetch(path, init?): Promise<Response>` — same error-handling shape as the existing `apiFetch`, but never attaches an Authorization header and never requires a session. Tasks 13 and 14 both use this.

- [ ] **Step 1: Add publicApiFetch**

Read `src/lib/api.ts` first (already read in full above). Add alongside the existing `apiFetch`:

```typescript
// Same error-handling shape as apiFetch, but for the public, pre-login pages (pricing,
// signup, contact-enterprise) — never attaches a session token, never requires one.
export async function publicApiFetch(path: string, init: Omit<RequestInit, "headers"> = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : {},
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    const code = typeof body?.error?.code === "string" ? body.error.code : null;
    throw new ApiError(message ?? `Request failed (${res.status}). Please try again.`, res.status, code);
  }
  return res;
}
```

- [ ] **Step 2: Write the Pricing page**

```typescript
// src/pages/pricing.tsx
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { publicApiFetch } from "@/lib/api";

interface Plan {
  id: string;
  name: string;
  orderLimit: number | null;
  monthlyFeeInr: number;
  includedMetaAccounts: number | null;
  includedGoogleAccounts: number | null;
  extraMetaAccountPriceInr: number;
  extraGoogleAccountPriceInr: number;
  extraShopifyStorePriceInr: number;
}

export default function Pricing() {
  const navigate = useNavigate();
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    publicApiFetch("/api/plans")
      .then((res) => res.json())
      .then(setPlans)
      .catch((err) => setError(err.message));
  }, []);

  const addonPrices = plans[0];

  return (
    <div className="min-h-screen bg-bg p-8">
      <h1 className="mb-6 text-2xl font-semibold text-text-primary">Pricing</h1>
      {error && <p className="text-negative">{error}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-[var(--radius-lg)] border border-border bg-surface p-6">
            <h2 className="text-lg font-semibold text-text-primary">{plan.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">{plan.orderLimit ? `Up to ${plan.orderLimit} orders/month` : "5,000+ orders/month"}</p>
            <p className="mt-4 text-2xl font-bold text-text-primary">
              {plan.id === "enterprise" ? `From ₹${plan.monthlyFeeInr.toLocaleString("en-IN")}` : `₹${plan.monthlyFeeInr.toLocaleString("en-IN")}`}
              <span className="text-sm font-normal text-text-secondary"> /brand/month</span>
            </p>
            <p className="mt-2 text-sm text-text-secondary">
              {plan.includedMetaAccounts ? `${plan.includedMetaAccounts} Meta + ${plan.includedGoogleAccounts} Google` : "Custom ad accounts"}
            </p>
            <Button
              className="mt-6 w-full"
              onClick={() => (plan.id === "enterprise" ? navigate("/contact-enterprise") : navigate(`/signup?plan=${plan.id}`))}
            >
              {plan.id === "enterprise" ? "Contact Us" : "Get Started"}
            </Button>
          </div>
        ))}
      </div>
      {addonPrices && (
        <div className="mt-8 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
          <h2 className="text-lg font-semibold text-text-primary">Add-ons</h2>
          <ul className="mt-2 space-y-1 text-sm text-text-secondary">
            <li>Extra Meta Ad Account — ₹{addonPrices.extraMetaAccountPriceInr}/month</li>
            <li>Extra Google Ads Account — ₹{addonPrices.extraGoogleAccountPriceInr}/month</li>
            <li>Extra Shopify Store (same brand) — ₹{addonPrices.extraShopifyStorePriceInr}/month</li>
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the route**

Read `src/App.tsx` first (already read in full above). Add the lazy import alongside the others:
```typescript
const Pricing = lazy(() => import("@/pages/pricing"));
```
Add the route as a top-level public route, outside `<Route element={<RequireAuth />}>`, alongside `/login`:
```typescript
<Route path="/pricing" element={<Pricing />} />
```

- [ ] **Step 4: Manual verification (no frontend test harness exists in this repo)**

Run: `npm run build`
Expected: builds clean, no TypeScript errors.

Run the dev server (`npm run dev`), navigate to `#/pricing`, and confirm all four plans render with real data from the running backend's `GET /api/plans` (point `VITE_API_URL` at a local backend with migrations applied through Task 1).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/pages/pricing.tsx src/App.tsx
git commit -m "feat(frontend): add the public pricing page"
```

---

### Task 13: Frontend — Signup page with Razorpay Checkout

**Files:**
- Create: `src/pages/signup.tsx`
- Modify: `src/App.tsx` (add the `/signup` route, outside `RequireAuth`)
- Modify: `index.html` (add Razorpay's Checkout script tag)

**Interfaces:**
- Consumes: `publicApiFetch` (Task 12), `POST /api/signup` and `POST /api/signup/complete` (Tasks 8–9).

- [ ] **Step 1: Add Razorpay's Checkout script**

Read `index.html` first. Add before the closing `</head>` tag:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

- [ ] **Step 2: Write the Signup page**

```typescript
// src/pages/signup.tsx
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publicApiFetch } from "@/lib/api";
import { supabase } from "@/lib/supabase";

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open(): void };
  }
}

export default function Signup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const planId = searchParams.get("plan") ?? "small";

  const [brandName, setBrandName] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const signupRes = await publicApiFetch("/api/signup", { method: "POST", body: JSON.stringify({ planId }) });
      const { razorpaySubscriptionId, razorpayKeyId } = await signupRes.json();

      const razorpay = new window.Razorpay({
        key: razorpayKeyId,
        subscription_id: razorpaySubscriptionId,
        name: "D2C Analytics Dashboard",
        prefill: { email },
        handler: async (response: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }) => {
          try {
            await publicApiFetch("/api/signup/complete", {
              method: "POST",
              body: JSON.stringify({
                razorpaySubscriptionId: response.razorpay_subscription_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
                planId,
                brandName,
                category,
                ownerName,
                email,
                password,
              }),
            });
            const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
            if (signInError) {
              setError(`Payment succeeded, but automatic sign-in failed: ${signInError.message}. Please log in manually.`);
              return;
            }
            navigate("/");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong provisioning your account.");
          } finally {
            setSubmitting(false);
          }
        },
        modal: { ondismiss: () => setSubmitting(false) },
      });
      razorpay.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong starting checkout.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">Create your account</h1>
        <Input placeholder="Brand name" value={brandName} onChange={(e) => setBrandName(e.target.value)} required />
        <Input placeholder="Category (e.g. Fashion & Apparel)" value={category} onChange={(e) => setCategory(e.target.value)} required />
        <Input placeholder="Your name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {error && <p className="text-[12.5px] text-negative">{error}</p>}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Processing…" : "Continue to payment"}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Add the route**

In `src/App.tsx`:
```typescript
const Signup = lazy(() => import("@/pages/signup"));
...
<Route path="/signup" element={<Signup />} />
```

- [ ] **Step 4: Manual verification**

Run: `npm run build`
Expected: builds clean.

With a backend running in Razorpay **test mode** (test API keys, a real test-mode Plan created in Razorpay's dashboard), walk through `#/pricing` → "Get Started" → fill the form → Razorpay's test Checkout opens → complete a test payment (Razorpay provides test card numbers for this) → confirm it redirects into the dashboard, logged in, and that the new client/subscription rows exist in the database.

- [ ] **Step 5: Commit**

```bash
git add src/pages/signup.tsx src/App.tsx index.html
git commit -m "feat(frontend): add the signup page with Razorpay Checkout"
```

---

### Task 14: Frontend — Contact Enterprise page

**Files:**
- Create: `src/pages/contact-enterprise.tsx`
- Modify: `src/App.tsx` (add the `/contact-enterprise` route, outside `RequireAuth`)

**Interfaces:**
- Consumes: `publicApiFetch` (Task 12), `POST /api/enterprise-leads` (Task 11).

- [ ] **Step 1: Write the page**

```typescript
// src/pages/contact-enterprise.tsx
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publicApiFetch } from "@/lib/api";

export default function ContactEnterprise() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [company, setCompany] = React.useState("");
  const [estimatedOrdersPerMonth, setEstimatedOrdersPerMonth] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await publicApiFetch("/api/enterprise-leads", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          company,
          estimatedOrdersPerMonth: estimatedOrdersPerMonth ? Number(estimatedOrdersPerMonth) : undefined,
          message: message || undefined,
        }),
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong submitting this.");
    }
  };

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-text-primary">Thanks — we'll be in touch shortly.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">Enterprise — Contact Us</h1>
        <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} required />
        <Input type="number" placeholder="Estimated orders/month (optional)" value={estimatedOrdersPerMonth} onChange={(e) => setEstimatedOrdersPerMonth(e.target.value)} />
        <Input placeholder="Anything else? (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        {error && <p className="text-[12.5px] text-negative">{error}</p>}
        <Button type="submit" className="w-full">Submit</Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `src/App.tsx`:
```typescript
const ContactEnterprise = lazy(() => import("@/pages/contact-enterprise"));
...
<Route path="/contact-enterprise" element={<ContactEnterprise />} />
```

- [ ] **Step 3: Manual verification**

Run: `npm run build`
Expected: builds clean. Navigate to `#/contact-enterprise`, submit the form, confirm a row appears in `enterprise_leads`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/contact-enterprise.tsx src/App.tsx
git commit -m "feat(frontend): add the Enterprise Contact Us lead form"
```
