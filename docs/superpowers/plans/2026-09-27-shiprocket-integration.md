# Shiprocket + Shipments + Operations (Plan 2 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client can connect their Shiprocket account with an API user's email + password, their shipments sync hourly into a `shipments` table, and the Operations page (courier table, delivery funnel, NDR/RTO KPIs) shows real courier data instead of mock data.

**Architecture:** A `courier_shiprocket` credentials connector (built on plan 1's framework) logs in fresh on every sync, pages through Shiprocket's order list, and upserts one `shipments` row per AWB. A new `GET /clients/:id/couriers/summary` endpoint aggregates shipments for the Operations page, and `GET /clients/:id/sales` takes its `rto_orders` from shipments when a client has any, so every RTO number in the app becomes real. The frontend gains a credentials dialog for credential-type platforms. Task 1-2 first clear the hardening items deferred from plan 1's final review.

**Tech Stack:** Node/Express/TypeScript, `pg`, Vitest + Supertest (server); React 19 + Vite + Tailwind + Radix wrappers (frontend).

**Spec:** `docs/superpowers/specs/2026-09-27-simple-integrations-design.md` (plan 2 of its 5-plan rollout; amended on 2026-09-27 for this plan)

## Global Constraints

- Server tests need a real Postgres: run them as `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run <files>`. Server type-check: `cd server && npx tsc --noEmit` (covers `server/src` only; baseline clean, keep it clean).
- Frontend verification is `npm run build` (`tsc -b`; `noUnusedLocals`/`noUnusedParameters` ON) and `npm run lint`. The repo has **no frontend test runner and this plan does not add one**. Lint has pre-existing warnings: before Task 8 record the baseline (`npm run lint 2>&1 | tail -5`), and after each frontend task the warning count must not increase and no warning may come from a file this plan creates.
- Secrets: credentials/tokens are encrypted with `encryptToken`/`decryptToken` (`server/src/lib/crypto.ts`), never returned by any endpoint, and never logged (log `err.message`, never a raw error object that could carry a request body).
- Errors use `HttpError(status, code, message)`; response body `{ error: { code, message } }`. A connector signals bad credentials with `CredentialsRejectedError` (`server/src/integrations/types.ts`); the connect route turns it into a 400 and turns any other failure into a generic 502.
- A sync must never resurrect a disconnected connection: every UPDATE that sets `status` from a sync path carries `and status <> 'disconnected'`.
- `OrderStatus` values (exact strings, used by `shipments.status` and the frontend): `Dispatched`, `In Transit`, `Out for Delivery`, `Delivered`, `NDR`, `RTO Initiated`, `RTO Delivered`, `Cancelled`.
- **Unconfirmed Shiprocket API facts.** Context7 and the (JavaScript-rendered) docs site do NOT confirm these; they are assumptions isolated in `server/src/integrations/shiprocket-api.ts` and `shiprocket-status.ts`, validated at runtime (unexpected shapes throw, sync goes to `error`, nothing bad is written), and MUST be confirmed against a real Shiprocket API user in Task 10:
  - Base URL `https://apiv2.shiprocket.in/v1/external`; `POST /auth/login` with `{ email, password }` returns `{ token }`; a bad login is HTTP 400/401/403/422.
  - `GET /orders` accepts `page` and `per_page` (also sent as `limit`, since docs disagree); returns `{ data: [order], meta: { pagination: { total_pages } } }` newest first.
  - Each order has `channel_order_id`, `status` (a label such as `DELIVERED`, `RTO INITIATED`), `customer_state`, `created_at`, and `shipments: [{ awb, courier, status?, delivered_date? }]` (`awb_code`/`courier_name`/`delivered_at` are also accepted).
  - Token lifetime is unknown (a Shiprocket SDK says 24 hours), hence a fresh login per sync.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` copied EXACTLY (never substitute your own model name).
- Rate-limiter state is module-level per test FILE: new `/connect` route tests go in NEW test files (fresh state), never appended to `connections-framework.test.ts` (it already uses its 10-call budget).

---

### Task 1: Harden `/connect` logging and clear secrets on disconnect

**Files:**
- Modify: `server/src/routes/connections.ts` (the `/connect` catch block; the `DELETE` handler)
- Create: `server/test/routes/connect-logging.test.ts`
- Modify: `server/test/routes/connections-framework.test.ts` (append two tests to the existing `DELETE` describe; add `encryptToken` to the existing `crypto.js` import)

**Interfaces:**
- Consumes: `installFakeCourier`, `FAKE_COURIER_PLATFORM` (`server/test/helpers/fake-courier.ts`); the `DELETE` describe's `del()` helper and `CREDS` constant already in `connections-framework.test.ts`.
- Produces: `/connect` logs only `err.message`; `DELETE /clients/:id/connections/:platform` also nulls `access_token`, `refresh_token`, `credentials` on every disconnected row of that platform for the client (rows are kept).

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes/connect-logging.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  // An error whose own properties carry the request body, like an HTTP client error might.
  restore = installFakeCourier({
    async connectWithCredentials() {
      throw Object.assign(new Error("ECONNREFUSED"), {
        request: { body: { email: "ops@abc.com", password: "hunter2-secret" } },
      });
    },
  });
});

afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("POST /connect logging", () => {
  it("logs only the error message, never the error object", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/clients/abc-fashion/connections/${FAKE_COURIER_PLATFORM}/connect`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: RIYA, email: "riya@agency.com" })}`)
      .send({ credentials: { email: "ops@abc.com", password: "hunter2-secret" } });

    expect(res.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("hunter2-secret");
  });
});
```

In `server/test/routes/connections-framework.test.ts` change the crypto import line to `import { decryptToken, encryptToken } from "../../src/lib/crypto.js";` and append inside `describe("DELETE /api/clients/:id/connections/:platform", ...)` (after its last existing `it`):

```ts
  it("clears stored secrets when disconnecting but keeps the row", async () => {
    await testPool.query("update platform_connections set access_token = $1, refresh_token = $2, credentials = $3", [
      encryptToken("tok"),
      encryptToken("ref"),
      encryptToken(JSON.stringify(CREDS)),
    ]);
    const res = await del(FAKE_COURIER_PLATFORM);
    expect(res.status).toBe(204);
    const row = (
      await testPool.query("select status, access_token, refresh_token, credentials from platform_connections")
    ).rows[0];
    expect(row).toEqual({ status: "disconnected", access_token: null, refresh_token: null, credentials: null });
  });

  it("disconnects every active connection of the platform for the client", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id) values
       ('abc-fashion', '${FAKE_COURIER_PLATFORM}', 'connected', 'second@abc.com')`,
    );
    const res = await del(FAKE_COURIER_PLATFORM);
    expect(res.status).toBe(204);
    const rows = (await testPool.query("select status from platform_connections order by external_account_id")).rows;
    expect(rows).toEqual([{ status: "disconnected" }, { status: "disconnected" }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connect-logging.test.ts test/routes/connections-framework.test.ts`
Expected: FAIL: the logging test (`hunter2-secret` appears in the logged object) and "clears stored secrets" (columns still hold values). "disconnects every active connection" should already pass.

- [ ] **Step 3: Fix the logging**

In `server/src/routes/connections.ts`, in the `/connect` handler's inner `catch (err)`, replace

```ts
      console.error(`Credential connect failed for ${platform}:`, err);
```

with

```ts
      // Log the message only: an error object from an HTTP client can carry the request body,
      // which for this endpoint contains the user's password.
      console.error(`Credential connect failed for ${platform}: ${err instanceof Error ? err.message : String(err)}`);
```

- [ ] **Step 4: Clear secrets on disconnect**

In the `router.delete("/:platform", ...)` handler, directly after the `for (const row of active.rows) { await connector.disconnect(row.id); }` loop and before `res.status(204).end();`, add:

```ts
    // Disconnect is a user-facing promise: stop holding the client's tokens and stored
    // credentials. The row and its synced data stay; reconnecting stores fresh secrets.
    await pool.query(
      `update platform_connections
       set access_token = null, refresh_token = null, credentials = null
       where client_id = $1 and platform = $2 and status = 'disconnected'`,
      [clientId, platform],
    );
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connect-logging.test.ts test/routes/connections-framework.test.ts test/routes/connections.test.ts test/routes/sync.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/connections.ts server/test/routes/connect-logging.test.ts server/test/routes/connections-framework.test.ts
git commit -m "$(cat <<'EOF'
fix(server): log only error messages from /connect and clear secrets on disconnect

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rate limiter — per-user bucket and key eviction

**Files:**
- Modify: `server/src/middleware/rate-limit.ts`
- Modify: `server/test/middleware/rate-limit.test.ts` (append two tests)
- Modify: `server/src/routes/connections.ts` (mount a second limiter on `/connect`)
- Create: `server/test/routes/connect-user-rate-limit.test.ts`

**Interfaces:**
- Consumes: existing `createRateLimiter`.
- Produces: `createRateLimiter({ max, windowMs, now?, scope?: "user" | "user-and-client", maxKeys?: number })` returns the middleware with an extra `size(): number` (current number of tracked keys). Default `scope` is `"user-and-client"` (existing behavior), default `maxKeys` is 5000: once the map holds more than `maxKeys` keys, fully expired keys are deleted before the next request is counted. `/connect` is limited to 10 per user+client and 30 per user, per 10 minutes.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("createRateLimiter", ...)` in `server/test/middleware/rate-limit.test.ts`:

```ts
  it("scope 'user' shares one bucket across clients", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => 0, scope: "user" });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u1", "c2"), res, next);
    limiter(fakeReq("u1", "c3"), res, next);
    expect(next.mock.calls[0]).toEqual([]);
    expect(next.mock.calls[1]).toEqual([]);
    expect(next.mock.calls[2][0]).toBeInstanceOf(HttpError);
  });

  it("evicts fully expired keys once the map exceeds maxKeys", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 5, windowMs: 1000, now: () => t, maxKeys: 2 });
    const next = vi.fn();
    limiter(fakeReq("u1", "c1"), res, next);
    limiter(fakeReq("u1", "c2"), res, next);
    limiter(fakeReq("u1", "c3"), res, next);
    expect(limiter.size()).toBe(3);
    t = 5000;
    limiter(fakeReq("u1", "c4"), res, next);
    expect(limiter.size()).toBe(1);
  });
```

Create `server/test/routes/connect-user-rate-limit.test.ts`:

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
  for (const id of ["c1", "c2", "c3", "c4"]) {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values ($1, $1, 'Fashion', 'bg-violet-500', 'A')`,
      [id],
    );
  }
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  restore = installFakeCourier();
});

afterEach(() => restore());

describe("connect per-user rate limiting", () => {
  it("blocks a user after 30 attempts in the window even across different clients", async () => {
    const token = signTestJwt({ sub: RIYA, email: "riya@agency.com" });
    const attempt = (clientId: string) =>
      request(app)
        .post(`/api/clients/${clientId}/connections/${FAKE_COURIER_PLATFORM}/connect`)
        .set("Authorization", `Bearer ${token}`)
        .send({ credentials: { email: "ops@abc.com", password: "x" } });

    for (const clientId of ["c1", "c2", "c3"]) {
      for (let i = 0; i < 10; i++) {
        expect((await attempt(clientId)).status).toBe(200);
      }
    }
    const blocked = await attempt("c4");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/middleware/rate-limit.test.ts test/routes/connect-user-rate-limit.test.ts`
Expected: FAIL (`scope`/`size` unknown; the c4 attempt returns 200).

- [ ] **Step 3: Replace the limiter implementation**

Replace the whole contents of `server/src/middleware/rate-limit.ts`:

```ts
import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/http-error.js";

// In-memory sliding-window limiter. The API runs as a single process, so a per-process map
// is enough; it exists to blunt credential-guessing through the connect endpoint, not to be
// a general-purpose quota system. Must be mounted after requireAuth so req.auth is set.
//
// scope "user-and-client" (default) counts per user per client; scope "user" counts per user
// across every client. Keys include a user-supplied client id, so once the map holds more
// than maxKeys entries, keys whose attempts have all expired are swept before counting.
export function createRateLimiter({
  max,
  windowMs,
  now = Date.now,
  scope = "user-and-client",
  maxKeys = 5000,
}: {
  max: number;
  windowMs: number;
  now?: () => number;
  scope?: "user" | "user-and-client";
  maxKeys?: number;
}) {
  const hits = new Map<string, number[]>();

  const middleware = (req: Request, _res: Response, next: NextFunction) => {
    const userId = req.auth?.userId ?? "anon";
    const key = scope === "user" ? userId : `${userId}:${req.params.id ?? ""}`;
    const t = now();

    if (hits.size > maxKeys) {
      for (const [k, stamps] of hits) {
        if (stamps.every((ts) => t - ts >= windowMs)) hits.delete(k);
      }
    }

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

  return Object.assign(middleware, { size: () => hits.size });
}
```

- [ ] **Step 4: Mount the per-user limiter**

In `server/src/routes/connections.ts`, replace the `connectLimiter` declaration and its comment

```ts
// 10 attempts per user per client per 10 minutes: enough for typos, too few for guessing.
const connectLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
```

with

```ts
// 10 attempts per user per client and 30 per user overall, per 10 minutes: enough for typos
// (and a few clients in a row), too few for guessing credentials.
const connectLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
const connectUserLimiter = createRateLimiter({ max: 30, windowMs: 10 * 60 * 1000, scope: "user" });
```

and change the route line `router.post("/:platform/connect", requireAuth, connectLimiter, async (req, res, next) => {` to

```ts
router.post("/:platform/connect", requireAuth, connectUserLimiter, connectLimiter, async (req, res, next) => {
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/middleware/rate-limit.test.ts test/routes/connect-user-rate-limit.test.ts test/routes/connect-rate-limit.test.ts test/routes/connections-framework.test.ts`
Expected: all PASS (`connect-rate-limit` still gets 200×10 then 429; `connections-framework` still fits its 10-call budget).

- [ ] **Step 6: Commit**

```bash
git add server/src/middleware/rate-limit.ts server/src/routes/connections.ts server/test/middleware/rate-limit.test.ts server/test/routes/connect-user-rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add per-user connect rate limit and evict expired limiter keys

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 007 — `shipments` table

**Files:**
- Create: `server/migrations/007_shipments.sql`
- Create: `server/test/migration-007.test.ts`

**Interfaces:**
- Produces: table `shipments (id uuid pk, client_id text → clients on delete cascade, connection_id uuid → platform_connections on delete cascade, awb text not null, order_ref text, courier_name text not null, status text not null (check: the 8 OrderStatus values), destination_state text, ordered_at timestamptz, delivered_at timestamptz, synced_at timestamptz default now())`, `unique (connection_id, awb)`, index on `(client_id, ordered_at)`. Tasks 5 and 7 rely on these exact column names.

- [ ] **Step 1: Write the failing test**

Create `server/test/migration-007.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

const CONN = "66666666-6666-6666-6666-666666666666";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${CONN}', 'abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com')`,
  );
});

const insertShipment = (awb: string, status = "In Transit") =>
  testPool.query(
    `insert into shipments (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at)
     values ('abc-fashion', '${CONN}', $1, '1001', 'Delhivery', $2, 'Maharashtra', now())`,
    [awb, status],
  );

describe("migration 007 (shipments)", () => {
  it("stores a shipment with a valid status", async () => {
    await insertShipment("AWB1", "RTO Initiated");
    const res = await testPool.query("select awb, status, delivered_at from shipments");
    expect(res.rows).toEqual([{ awb: "AWB1", status: "RTO Initiated", delivered_at: null }]);
  });

  it("rejects a status outside the OrderStatus set", async () => {
    await expect(insertShipment("AWB2", "Teleported")).rejects.toThrow();
  });

  it("allows one row per (connection, awb)", async () => {
    await insertShipment("AWB3");
    await expect(insertShipment("AWB3")).rejects.toThrow();
  });

  it("deletes shipments when their connection is deleted", async () => {
    await insertShipment("AWB4");
    await testPool.query("delete from platform_connections where id = $1", [CONN]);
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-007.test.ts`
Expected: FAIL (`relation "shipments" does not exist`).

- [ ] **Step 3: Write the migration**

Create `server/migrations/007_shipments.sql`:

```sql
create table shipments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  awb text not null,
  -- the courier's reference for the merchant order; kept for a future match to shopify_orders
  order_ref text,
  courier_name text not null,
  status text not null check (status in (
    'Dispatched', 'In Transit', 'Out for Delivery', 'Delivered', 'NDR', 'RTO Initiated', 'RTO Delivered', 'Cancelled'
  )),
  destination_state text,
  ordered_at timestamptz,
  delivered_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (connection_id, awb)
);

create index shipments_client_ordered_idx on shipments (client_id, ordered_at);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-007.test.ts test/migration-006.test.ts test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/007_shipments.sql server/test/migration-007.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add shipments table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Shiprocket status mapper and API client

**Files:**
- Create: `server/src/integrations/shiprocket-status.ts`
- Create: `server/src/integrations/shiprocket-api.ts`
- Create: `server/test/integrations/shiprocket-status.test.ts`
- Create: `server/test/integrations/shiprocket-api.test.ts`

**Interfaces:**
- Produces (`shiprocket-status.ts`): `type ShipmentStatus` (the 8 OrderStatus strings) and `mapShiprocketStatus(raw: string | null | undefined): ShipmentStatus | null` (null = unknown label).
- Produces (`shiprocket-api.ts`): `class ShiprocketAuthError extends Error`; `interface ShiprocketShipment { awb: string; courier: string | null; status: string | null; deliveredAt: Date | null }`; `interface ShiprocketOrder { orderRef: string | null; status: string | null; state: string | null; createdAt: Date | null; shipments: ShiprocketShipment[] }`; `interface ShiprocketOrdersPage { orders: ShiprocketOrder[]; totalPages: number }`; `shiprocketLogin(email: string, password: string): Promise<string>`; `fetchOrdersPage(token: string, page: number, perPage: number): Promise<ShiprocketOrdersPage>`. Task 5 consumes all of these.

- [ ] **Step 1: Write the failing status tests**

Create `server/test/integrations/shiprocket-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapShiprocketStatus } from "../../src/integrations/shiprocket-status.js";

describe("mapShiprocketStatus", () => {
  it.each([
    ["NEW", "Dispatched"],
    ["INVOICED", "Dispatched"],
    ["READY TO SHIP", "Dispatched"],
    ["PICKUP SCHEDULED", "Dispatched"],
    ["PICKUP GENERATED", "Dispatched"],
    ["OUT FOR PICKUP", "Dispatched"],
    ["MANIFEST GENERATED", "Dispatched"],
    ["AWB ASSIGNED", "Dispatched"],
    ["PICKED UP", "In Transit"],
    ["SHIPPED", "In Transit"],
    ["IN TRANSIT", "In Transit"],
    ["REACHED AT DESTINATION HUB", "In Transit"],
    ["OUT FOR DELIVERY", "Out for Delivery"],
    ["DELIVERED", "Delivered"],
    ["UNDELIVERED", "NDR"],
    ["UNDELIVERED-1st Attempt", "NDR"],
    ["NDR", "NDR"],
    ["RTO INITIATED", "RTO Initiated"],
    ["RTO IN TRANSIT", "RTO Initiated"],
    ["RTO OFD", "RTO Initiated"],
    ["RTO DELIVERED", "RTO Delivered"],
    ["CANCELED", "Cancelled"],
    ["CANCELLATION REQUESTED", "Cancelled"],
    ["  delivered  ", "Delivered"],
    ["rto delivered", "RTO Delivered"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapShiprocketStatus(raw)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["   "], ["LOST"], ["SOMETHING NEW"]])("returns null for %j", (raw) => {
    expect(mapShiprocketStatus(raw as string | null | undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shiprocket-status.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the status mapper**

Create `server/src/integrations/shiprocket-status.ts`:

```ts
export type ShipmentStatus =
  | "Dispatched"
  | "In Transit"
  | "Out for Delivery"
  | "Delivered"
  | "NDR"
  | "RTO Initiated"
  | "RTO Delivered"
  | "Cancelled";

const DISPATCHED_EXACT = new Set(["NEW", "INVOICED"]);
const DISPATCHED_PARTS = ["READY TO SHIP", "PICKUP", "MANIFEST", "AWB"];
const IN_TRANSIT_PARTS = ["IN TRANSIT", "SHIPPED", "PICKED UP", "REACHED", "DESTINATION HUB", "MISROUTED"];

// Shiprocket reports free-text status labels. Order matters: RTO labels also contain words
// like DELIVERED / IN TRANSIT, and UNDELIVERED contains DELIVERED, so the specific checks
// run first. Returns null for labels we don't recognize so the caller can log them and pick
// a fallback instead of this function silently guessing.
export function mapShiprocketStatus(raw: string | null | undefined): ShipmentStatus | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("RTO")) return s.includes("DELIVERED") ? "RTO Delivered" : "RTO Initiated";
  if (s.includes("CANCEL")) return "Cancelled";
  if (s.includes("UNDELIVERED") || s === "NDR" || s.startsWith("NDR ")) return "NDR";
  if (s.includes("OUT FOR DELIVERY")) return "Out for Delivery";
  if (s.includes("DELIVERED")) return "Delivered";
  if (IN_TRANSIT_PARTS.some((part) => s.includes(part))) return "In Transit";
  if (DISPATCHED_EXACT.has(s) || DISPATCHED_PARTS.some((part) => s.includes(part))) return "Dispatched";
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shiprocket-status.test.ts`
Expected: PASS (31 cases).

- [ ] **Step 5: Write the failing API-client tests**

Create `server/test/integrations/shiprocket-api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchOrdersPage, shiprocketLogin, ShiprocketAuthError } from "../../src/integrations/shiprocket-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("shiprocketLogin", () => {
  it("posts the credentials as JSON and returns the token", async () => {
    const fetchMock = stubFetch({ token: "abc123" });
    await expect(shiprocketLogin("ops@abc.com", "pw")).resolves.toBe("abc123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/external/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "ops@abc.com", password: "pw" });
  });

  it.each([400, 401, 403, 422])("throws ShiprocketAuthError on HTTP %i", async (status) => {
    stubFetch({ message: "Invalid email or password" }, status);
    await expect(shiprocketLogin("ops@abc.com", "bad")).rejects.toBeInstanceOf(ShiprocketAuthError);
  });

  it("throws a plain error on a server failure", async () => {
    stubFetch({}, 500);
    const err = await shiprocketLogin("ops@abc.com", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ShiprocketAuthError);
  });

  it("throws when the response has no token", async () => {
    stubFetch({ hello: "world" });
    await expect(shiprocketLogin("ops@abc.com", "pw")).rejects.toThrow(/no token/);
  });
});

const ORDERS_FIXTURE = {
  data: [
    {
      id: 1001,
      channel_order_id: "1001",
      status: "DELIVERED",
      customer_state: "Maharashtra",
      created_at: "2026-09-20 10:00:00",
      shipments: [{ awb: "AWB1", courier: "Delhivery", status: "DELIVERED", delivered_date: "2026-09-24 12:00:00" }],
    },
    { id: 1002, channel_order_id: 1002, status: "NEW", customer_state: null, created_at: "2026-09-21 10:00:00", shipments: [] },
    {
      id: 1003,
      channel_order_id: "1003",
      status: "RTO INITIATED",
      created_at: "not a date",
      shipments: [{ awb_code: "AWB3", courier_name: "Bluedart" }, "junk"],
    },
  ],
  meta: { pagination: { total_pages: 3 } },
};

describe("fetchOrdersPage", () => {
  it("parses orders, shipments and pagination", async () => {
    stubFetch(ORDERS_FIXTURE);
    const page = await fetchOrdersPage("tok", 1, 100);

    expect(page.totalPages).toBe(3);
    expect(page.orders).toHaveLength(3);
    expect(page.orders[0]).toMatchObject({ orderRef: "1001", status: "DELIVERED", state: "Maharashtra" });
    expect(page.orders[0].createdAt).toBeInstanceOf(Date);
    expect(page.orders[0].shipments).toEqual([
      { awb: "AWB1", courier: "Delhivery", status: "DELIVERED", deliveredAt: expect.any(Date) },
    ]);
    expect(page.orders[1]).toMatchObject({ orderRef: "1002", state: null, shipments: [] });
    expect(page.orders[2].createdAt).toBeNull();
    expect(page.orders[2].shipments).toEqual([{ awb: "AWB3", courier: "Bluedart", status: null, deliveredAt: null }]);
  });

  it("sends the bearer token and paging params", async () => {
    const fetchMock = stubFetch({ data: [] });
    await fetchOrdersPage("tok-1", 2, 50);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/external/orders?");
    expect(new URL(url).searchParams.get("page")).toBe("2");
    expect(new URL(url).searchParams.get("per_page")).toBe("50");
    expect(new URL(url).searchParams.get("limit")).toBe("50");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("defaults to one page when pagination metadata is missing", async () => {
    stubFetch({ data: [] });
    expect((await fetchOrdersPage("tok", 1, 100)).totalPages).toBe(1);
  });

  it("throws on an unexpected response shape", async () => {
    stubFetch({ orders: [] });
    await expect(fetchOrdersPage("tok", 1, 100)).rejects.toThrow(/unexpected orders response/);
  });

  it("throws ShiprocketAuthError on 401 and a plain error on 500", async () => {
    stubFetch({}, 401);
    await expect(fetchOrdersPage("tok", 1, 100)).rejects.toBeInstanceOf(ShiprocketAuthError);
    stubFetch({}, 500);
    const err = await fetchOrdersPage("tok", 1, 100).catch((e) => e);
    expect(err).not.toBeInstanceOf(ShiprocketAuthError);
    expect(err.message).toContain("500");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shiprocket-api.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the API client**

Create `server/src/integrations/shiprocket-api.ts`:

```ts
// All knowledge of Shiprocket's HTTP API lives in this file. The response shapes below are
// ASSUMPTIONS (see the plan's Global Constraints): every field is read defensively and an
// unexpected envelope throws, so a wrong assumption surfaces as a failed sync instead of
// garbage rows. Confirm against a real Shiprocket API user before relying on it.
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

// Bad login or an expired/invalid session token. Distinct from transient failures so callers
// can ask the user to reconnect instead of retrying.
export class ShiprocketAuthError extends Error {}

export interface ShiprocketShipment {
  awb: string;
  courier: string | null;
  status: string | null;
  deliveredAt: Date | null;
}

export interface ShiprocketOrder {
  orderRef: string | null;
  status: string | null;
  state: string | null;
  createdAt: Date | null;
  shipments: ShiprocketShipment[];
}

export interface ShiprocketOrdersPage {
  orders: ShiprocketOrder[];
  totalPages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function parseShipment(raw: unknown): ShiprocketShipment | null {
  if (!isRecord(raw)) return null;
  const awb = asString(raw.awb) ?? asString(raw.awb_code);
  if (!awb) return null;
  return {
    awb,
    courier: asString(raw.courier) ?? asString(raw.courier_name),
    status: asString(raw.status),
    deliveredAt: asDate(raw.delivered_date) ?? asDate(raw.delivered_at),
  };
}

function parseOrder(raw: unknown): ShiprocketOrder {
  if (!isRecord(raw)) {
    throw new Error("Shiprocket returned an unexpected order entry");
  }
  const shipments: ShiprocketShipment[] = [];
  if (Array.isArray(raw.shipments)) {
    for (const entry of raw.shipments) {
      const shipment = parseShipment(entry);
      if (shipment) shipments.push(shipment);
    }
  }
  return {
    orderRef: asString(raw.channel_order_id) ?? asString(raw.id),
    status: asString(raw.status),
    state: asString(raw.customer_state),
    createdAt: asDate(raw.created_at),
    shipments,
  };
}

export async function shiprocketLogin(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if ([400, 401, 403, 422].includes(res.status)) {
    throw new ShiprocketAuthError("Shiprocket rejected the login");
  }
  if (!res.ok) {
    throw new Error(`Shiprocket login failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  const token = isRecord(body) ? asString(body.token) : null;
  if (!token) {
    throw new Error("Shiprocket login returned no token");
  }
  return token;
}

export async function fetchOrdersPage(token: string, page: number, perPage: number): Promise<ShiprocketOrdersPage> {
  // Shiprocket's docs disagree on the page-size parameter name (per_page vs limit), so send both.
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage), limit: String(perPage) });
  const res = await fetch(`${API_BASE}/orders?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new ShiprocketAuthError("Shiprocket rejected the session token");
  }
  if (!res.ok) {
    throw new Error(`Shiprocket orders fetch failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Shiprocket returned an unexpected orders response (no data array)");
  }
  const pagination = isRecord(body.meta) && isRecord(body.meta.pagination) ? body.meta.pagination : null;
  const totalPages = pagination && typeof pagination.total_pages === "number" ? pagination.total_pages : 1;
  return { orders: body.data.map((entry) => parseOrder(entry)), totalPages };
}
```

- [ ] **Step 8: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shiprocket-status.test.ts test/integrations/shiprocket-api.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/integrations/shiprocket-status.ts server/src/integrations/shiprocket-api.ts server/test/integrations/shiprocket-status.test.ts server/test/integrations/shiprocket-api.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add Shiprocket API client and status mapper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Shiprocket connector, registry, couriers list, scheduler

**Files:**
- Create: `server/src/integrations/shiprocket.ts`
- Modify: `server/src/lib/connector-registry.ts`
- Modify: `server/src/routes/couriers.ts`
- Modify: `server/src/scheduler.ts`
- Create: `server/test/integrations/shiprocket.test.ts`
- Modify: `server/test/routes/couriers.test.ts`
- Modify: `server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `CredentialsConnector`, `CredentialsRejectedError` (`types.ts`); everything exported by `shiprocket-api.ts` and `shiprocket-status.ts` (Task 4); the `shipments` table (Task 3); `decryptToken`.
- Produces: `shiprocketConnector: CredentialsConnector` (platform `"courier_shiprocket"`) registered in `connectors`; `GET /api/couriers` lists Shiprocket as available; hourly (minute 15) scheduled sync for `courier_shiprocket`.

- [ ] **Step 1: Write the failing connector tests**

Create `server/test/integrations/shiprocket.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";
import { shiprocketConnector } from "../../src/integrations/shiprocket.js";
import { CredentialsRejectedError } from "../../src/integrations/types.js";

const CONN = "66666666-6666-6666-6666-666666666666";
const CREDS = { email: "ops@abc.com", password: "pw-secret" };
const DAY = 24 * 60 * 60 * 1000;
const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

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
  vi.restoreAllMocks();
});

async function insertConnection(status = "connected", creds: object | null = CREDS) {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, credentials, external_account_id)
     values ($1, 'abc-fashion', 'courier_shiprocket', $2, $3, $4, 'ops@abc.com')`,
    [CONN, status, encryptToken("old-token"), creds ? encryptToken(JSON.stringify(creds)) : null],
  );
}

// pages[i] is the JSON body returned for `page=i+1`; a missing page returns an empty list.
function stubShiprocket(pages: unknown[], opts: { loginStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/auth/login")) {
      if (opts.loginStatus && opts.loginStatus !== 200) return new Response("{}", { status: opts.loginStatus });
      return new Response(JSON.stringify({ token: "fresh-token" }), { status: 200 });
    }
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(pages[page - 1] ?? { data: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const order = (ref: string, status: string, shipments: unknown[], createdAt = recent(2), state: string | null = "Maharashtra") => ({
  id: Number(ref),
  channel_order_id: ref,
  status,
  customer_state: state,
  created_at: createdAt,
  shipments,
});

describe("shiprocketConnector.connectWithCredentials", () => {
  it("logs in, lowercases the email and stores only email + password", async () => {
    const fetchMock = stubShiprocket([]);
    const result = await shiprocketConnector.connectWithCredentials("abc-fashion", {
      email: "  Ops@ABC.com ",
      password: "pw-secret",
      evil: "should be dropped",
    });
    expect(result).toEqual({
      externalAccountId: "ops@abc.com",
      accessToken: "fresh-token",
      credentials: { email: "ops@abc.com", password: "pw-secret" },
    });
    const loginBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(loginBody).toEqual({ email: "ops@abc.com", password: "pw-secret" });
  });

  it("rejects a blank email or password without calling Shiprocket", async () => {
    const fetchMock = stubShiprocket([]);
    await expect(shiprocketConnector.connectWithCredentials("abc-fashion", { email: "", password: "" })).rejects.toBeInstanceOf(
      CredentialsRejectedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a rejected login into a user-facing CredentialsRejectedError", async () => {
    stubShiprocket([], { loginStatus: 403 });
    const err = await shiprocketConnector.connectWithCredentials("abc-fashion", CREDS).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err.message).toContain("API user");
  });

  it("lets non-auth failures through as ordinary errors", async () => {
    stubShiprocket([], { loginStatus: 500 });
    const err = await shiprocketConnector.connectWithCredentials("abc-fashion", CREDS).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CredentialsRejectedError);
  });
});

describe("shiprocketConnector.sync", () => {
  it("upserts one shipment per AWB across pages and skips orders without shipments", async () => {
    await insertConnection();
    stubShiprocket([
      {
        data: [
          order("1001", "DELIVERED", [{ awb: "AWB1", courier: "Delhivery", status: "DELIVERED", delivered_date: recent(1) }]),
          order("1002", "NEW", []),
        ],
        meta: { pagination: { total_pages: 2 } },
      },
      { data: [order("1003", "RTO INITIATED", [{ awb: "AWB3", courier: "Bluedart", status: "RTO INITIATED" }], recent(3), "Delhi")] },
    ]);

    const result = await shiprocketConnector.sync(CONN);

    expect(result).toEqual({ recordsSynced: 2 });
    const rows = (
      await testPool.query(
        "select awb, order_ref, courier_name, status, destination_state, ordered_at is not null as has_ordered, delivered_at is not null as has_delivered from shipments order by awb",
      )
    ).rows;
    expect(rows).toEqual([
      { awb: "AWB1", order_ref: "1001", courier_name: "Delhivery", status: "Delivered", destination_state: "Maharashtra", has_ordered: true, has_delivered: true },
      { awb: "AWB3", order_ref: "1003", courier_name: "Bluedart", status: "RTO Initiated", destination_state: "Delhi", has_ordered: true, has_delivered: false },
    ]);
    const conn = (await testPool.query("select status, last_synced_at from platform_connections")).rows[0];
    expect(conn.status).toBe("connected");
    expect(conn.last_synced_at).not.toBeNull();
  });

  it("is idempotent and updates a shipment's status on the next run", async () => {
    await insertConnection();
    stubShiprocket([{ data: [order("1001", "IN TRANSIT", [{ awb: "AWB1", courier: "Delhivery" }])] }]);
    await shiprocketConnector.sync(CONN);
    stubShiprocket([{ data: [order("1001", "DELIVERED", [{ awb: "AWB1", courier: "Delhivery" }])] }]);
    await shiprocketConnector.sync(CONN);

    const rows = (await testPool.query("select awb, status from shipments")).rows;
    expect(rows).toEqual([{ awb: "AWB1", status: "Delivered" }]);
  });

  it("logs in with the stored credentials at the start of every sync", async () => {
    await insertConnection();
    const fetchMock = stubShiprocket([{ data: [] }]);
    await shiprocketConnector.sync(CONN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/auth/login");
    expect(JSON.parse(init.body as string)).toEqual(CREDS);
    const ordersCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((ordersCall[1].headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
  });

  it("stops paging once a whole page is older than the 30 day window", async () => {
    await insertConnection();
    const old = recent(90);
    const fetchMock = stubShiprocket([
      { data: [order("900", "DELIVERED", [{ awb: "OLD1", courier: "Delhivery" }], old)], meta: { pagination: { total_pages: 5 } } },
    ]);
    await shiprocketConnector.sync(CONN);
    // one login + exactly one orders page
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails clearly, and writes nothing, when the stored credentials are rejected", async () => {
    await insertConnection();
    stubShiprocket([], { loginStatus: 403 });
    await expect(shiprocketConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });

  it("fails when the connection has no stored credentials", async () => {
    await insertConnection("connected", null);
    stubShiprocket([]);
    await expect(shiprocketConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
  });

  it("falls back to In Transit and warns for an unrecognized status label", async () => {
    await insertConnection();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubShiprocket([{ data: [order("1001", "SOMETHING NEW", [{ awb: "AWB1", courier: "Delhivery" }])] }]);
    await shiprocketConnector.sync(CONN);
    expect((await testPool.query("select status from shipments")).rows).toEqual([{ status: "In Transit" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("SOMETHING NEW");
  });

  it("does not resurrect a disconnected connection", async () => {
    await insertConnection("disconnected");
    stubShiprocket([{ data: [] }]);
    await shiprocketConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("disconnected");
  });

  it("recovers a connection stuck in error", async () => {
    await insertConnection("error");
    stubShiprocket([{ data: [] }]);
    await shiprocketConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("connected");
  });
});

describe("shiprocketConnector.disconnect", () => {
  it("marks the connection disconnected", async () => {
    await insertConnection();
    await shiprocketConnector.disconnect(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("disconnected");
  });
});
```

Modify `server/test/routes/couriers.test.ts`: replace the second test with

```ts
  it("lists known couriers, only Shiprocket available so far", async () => {
    const token = signTestJwt({ sub: "any-user", email: "someone@agency.com" });
    const res = await request(app).get("/api/couriers").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "courier_shiprocket", name: "Shiprocket", available: true },
      { id: "courier_delhivery", name: "Delhivery", available: false },
      { id: "courier_shadowfax", name: "Shadowfax", available: false },
    ]);
  });
```

In `server/test/scheduler.test.ts`, append inside `describe("startScheduler", ...)`:

```ts
  it("schedules an hourly Shiprocket sync at minute 15", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("15 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shiprocket.test.ts test/routes/couriers.test.ts test/scheduler.test.ts`
Expected: FAIL (connector module missing; couriers list and scheduler assertions differ).

- [ ] **Step 3: Implement the connector**

Create `server/src/integrations/shiprocket.ts`:

```ts
import type { CredentialsConnector } from "./types.js";
import { CredentialsRejectedError } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
import { fetchOrdersPage, shiprocketLogin, ShiprocketAuthError, type ShiprocketOrdersPage } from "./shiprocket-api.js";
import { mapShiprocketStatus } from "./shiprocket-status.js";

const SYNC_WINDOW_DAYS = 30;
const PER_PAGE = 100;
// Hard stop against a runaway pagination loop: 50 pages x 100 orders.
const MAX_PAGES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const RECONNECT_MESSAGE = "Shiprocket rejected the stored credentials. Reconnect with the API user's current password.";

export const shiprocketConnector: CredentialsConnector = {
  platform: "courier_shiprocket",
  authType: "credentials",

  async connectWithCredentials(_clientId, credentials) {
    // Whitelist the two fields we use; anything else the browser sent is dropped, never stored.
    const email = (credentials.email ?? "").trim().toLowerCase();
    const password = credentials.password ?? "";
    if (!email || !password.trim()) {
      throw new CredentialsRejectedError("Enter both the API user's email and password.");
    }

    let token: string;
    try {
      token = await shiprocketLogin(email, password);
    } catch (err) {
      if (err instanceof ShiprocketAuthError) {
        throw new CredentialsRejectedError(
          "Shiprocket rejected these credentials. Use the API user's email and password (Shiprocket → Settings → API), not your main login.",
        );
      }
      throw err;
    }
    // No expiresAt: every sync logs in fresh, so we never depend on this token's lifetime.
    return { externalAccountId: email, accessToken: token, credentials: { email, password } };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query("select client_id, credentials from platform_connections where id = $1", [connectionId]);
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    if (!conn.credentials) {
      throw new Error("This Shiprocket connection has no stored credentials. Reconnect it.");
    }
    const { email, password } = JSON.parse(decryptToken(conn.credentials)) as { email: string; password: string };

    let token: string;
    try {
      token = await shiprocketLogin(email, password);
    } catch (err) {
      if (err instanceof ShiprocketAuthError) throw new Error(RECONNECT_MESSAGE);
      throw err;
    }

    // Orders arrive newest first. Non-terminal shipments older than the window are not
    // re-polled: an accepted gap for this version.
    const cutoff = Date.now() - SYNC_WINDOW_DAYS * DAY_MS;
    const unmapped = new Set<string>();
    let recordsSynced = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      let ordersPage: ShiprocketOrdersPage;
      try {
        ordersPage = await fetchOrdersPage(token, page, PER_PAGE);
      } catch (err) {
        if (err instanceof ShiprocketAuthError) throw new Error(RECONNECT_MESSAGE);
        throw err;
      }
      const { orders, totalPages } = ordersPage;

      for (const order of orders) {
        for (const shipment of order.shipments) {
          const rawStatus = shipment.status ?? order.status;
          const mapped = mapShiprocketStatus(rawStatus);
          if (!mapped && rawStatus) unmapped.add(rawStatus);

          await pool.query(
            `insert into shipments
               (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at, delivered_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (connection_id, awb)
             do update set order_ref = excluded.order_ref, courier_name = excluded.courier_name,
               status = excluded.status, destination_state = excluded.destination_state,
               ordered_at = excluded.ordered_at, delivered_at = excluded.delivered_at, synced_at = now()`,
            [
              conn.client_id,
              connectionId,
              shipment.awb,
              order.orderRef,
              shipment.courier ?? "Unknown courier",
              mapped ?? "In Transit",
              order.state,
              order.createdAt,
              shipment.deliveredAt,
            ],
          );
          recordsSynced++;
        }
      }

      const pageIsEntirelyOld =
        orders.length > 0 && orders.every((o) => o.createdAt !== null && o.createdAt.getTime() < cutoff);
      if (orders.length === 0 || page >= totalPages || pageIsEntirelyOld) break;
    }

    if (unmapped.size > 0) {
      console.warn(`Shiprocket: unrecognized status labels treated as In Transit: ${[...unmapped].join(", ")}`);
    }

    await pool.query(
      "update platform_connections set last_synced_at = now(), status = 'connected' where id = $1 and status <> 'disconnected'",
      [connectionId],
    );
    return { recordsSynced };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
```

- [ ] **Step 4: Register the connector, update the courier list, schedule the sync**

In `server/src/lib/connector-registry.ts` add `import { shiprocketConnector } from "../integrations/shiprocket.js";` and the entry `courier_shiprocket: shiprocketConnector,` to the `connectors` object.

In `server/src/routes/couriers.ts` replace `KNOWN_COURIERS` with:

```ts
const KNOWN_COURIERS = [
  { id: "courier_shiprocket", name: "Shiprocket", available: true },
  { id: "courier_delhivery", name: "Delhivery", available: false },
  { id: "courier_shadowfax", name: "Shadowfax", available: false },
];
```

In `server/src/scheduler.ts`, at the end of `startScheduler()` (after the Google schedule), add:

```ts

  // Courier statuses change through the day and Shiprocket's list endpoint is cheap, so sync
  // hourly like Shopify, offset to minute 15 so the two don't hit the database together.
  cron.schedule(
    "15 * * * *",
    () => {
      runScheduledSyncs("courier_shiprocket").catch((err) => console.error("Shiprocket scheduled sync failed:", err));
    },
    { noOverlap: true },
  );
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shiprocket.test.ts test/routes/couriers.test.ts test/scheduler.test.ts test/routes/connections-framework.test.ts test/routes/connect-rate-limit.test.ts`
Expected: all PASS (`fake-courier` restores the real Shiprocket connector after each framework test).

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/shiprocket.ts server/src/lib/connector-registry.ts server/src/routes/couriers.ts server/src/scheduler.ts server/test/integrations/shiprocket.test.ts server/test/routes/couriers.test.ts server/test/scheduler.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add Shiprocket connector with hourly shipment sync

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Route-level test through the real Shiprocket connector

**Files:**
- Create: `server/test/routes/connect-shiprocket.test.ts`

**Interfaces:**
- Consumes: the real `courier_shiprocket` connector registered in Task 5, `POST /connect`, `POST /:platform/sync`. No production code changes; this proves the whole path (route → connector → `saveConnection` → sync → `shipments`).

- [ ] **Step 1: Write the test**

Create `server/test/routes/connect-shiprocket.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { decryptToken } from "../../src/lib/crypto.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubShiprocket(opts: { loginStatus?: number; orders?: unknown[] } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/auth/login")) {
        if (opts.loginStatus && opts.loginStatus !== 200) return new Response("{}", { status: opts.loginStatus });
        return new Response(JSON.stringify({ token: "fresh-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: opts.orders ?? [] }), { status: 200 });
    }),
  );
}

const connect = (credentials: unknown) =>
  request(app)
    .post("/api/clients/abc-fashion/connections/courier_shiprocket/connect")
    .set("Authorization", `Bearer ${token()}`)
    .send({ credentials });

describe("connecting Shiprocket end to end", () => {
  it("connects, stores only email + password encrypted, then a manual sync writes shipments", async () => {
    stubShiprocket({
      orders: [
        {
          id: 1001,
          channel_order_id: "1001",
          status: "IN TRANSIT",
          customer_state: "Karnataka",
          created_at: new Date().toISOString(),
          shipments: [{ awb: "AWB1", courier: "Delhivery" }],
        },
      ],
    });

    const res = await connect({ email: "Ops@ABC.com", password: "pw-secret", extra: "drop me" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "courier_shiprocket", status: "connected", externalAccountId: "ops@abc.com" });

    const row = (await testPool.query("select access_token, credentials from platform_connections")).rows[0];
    expect(decryptToken(row.access_token)).toBe("fresh-token");
    expect(JSON.parse(decryptToken(row.credentials))).toEqual({ email: "ops@abc.com", password: "pw-secret" });
    expect(row.credentials).not.toContain("pw-secret");

    const sync = await request(app)
      .post("/api/clients/abc-fashion/connections/courier_shiprocket/sync")
      .set("Authorization", `Bearer ${token()}`);
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ recordsSynced: 1 });
    expect((await testPool.query("select awb, status, courier_name from shipments")).rows).toEqual([
      { awb: "AWB1", status: "In Transit", courier_name: "Delhivery" },
    ]);
  });

  it("returns a 400 with Shiprocket's rejection message and creates nothing when the login is refused", async () => {
    stubShiprocket({ loginStatus: 403 });
    const res = await connect({ email: "ops@abc.com", password: "wrong" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("credentials_rejected");
    expect(res.body.error.message).toContain("Shiprocket rejected");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("returns a generic 502 when Shiprocket itself is failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubShiprocket({ loginStatus: 500 });
    const res = await connect({ email: "ops@abc.com", password: "pw" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("provider_unreachable");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connect-shiprocket.test.ts`
Expected: PASS (3 tests). If a test fails, that reveals a real integration bug in Tasks 1-5: fix the production code responsible (not the test) and mention it in your report.

- [ ] **Step 3: Commit**

```bash
git add server/test/routes/connect-shiprocket.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover Shiprocket connect and manual sync through the routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Courier summary endpoint and shipment-based RTO in `/sales`

**Files:**
- Modify: `server/src/lib/access.ts` (add `resolveClientScope`)
- Modify: `server/src/routes/shopify-data.ts` (`/sales` uses the helper and shipment RTO)
- Create: `server/src/routes/courier-data.ts`
- Modify: `server/src/index.ts` (mount the router)
- Create: `server/test/routes/courier-data.test.ts`
- Modify: `server/test/routes/shopify-data.test.ts` (append one describe)

**Interfaces:**
- Produces: `resolveClientScope(db: pg.Pool, userId: string, clientId: string): Promise<string[]>` (for `clientId === "all"` returns every accessible client id; otherwise asserts access and returns `[clientId]`); `GET /api/clients/:id/couriers/summary?days=N` (`:id` may be `all`; `days` clamps to 1-730, default 30) returning
  ```ts
  { connected: boolean;
    statusCounts: Record<string, number>;
    couriers: { name: string; orders: number; delivered: number; rtoPercent: number; ndrPercent: number; avgDeliveryDays: number | null }[] }
  ```
  (couriers sorted by orders desc then name; percentages rounded to 1 decimal; shipments with a null `ordered_at` are excluded). `/sales` `rtoOrders` per day comes from shipments whose status is `RTO Initiated`/`RTO Delivered`, grouped by `ordered_at::date`, whenever the scoped clients have any shipments; otherwise it keeps the Shopify-derived value. Task 9 consumes the summary shape.

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes/courier-data.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const SCOPED = "22222222-2222-2222-2222-222222222222";
const CONN = "66666666-6666-6666-6666-666666666666";
const CONN_B = "77777777-7777-7777-7777-777777777777";
const get = (path: string, sub = RIYA, email = "riya@agency.com") =>
  request(app).get(path).set("Authorization", `Bearer ${signTestJwt({ sub, email })}`);

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
     ('${SCOPED}', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion', 'bg-violet-500', 'A'),
     ('xyz-beauty', 'XYZ Beauty', 'Beauty', 'bg-rose-500', 'X')`,
  );
  await testPool.query(`insert into team_member_clients (team_member_id, client_id) values ('${SCOPED}', 'xyz-beauty')`);
});

async function connectCourier(id: string, clientId: string, status = "connected") {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id)
     values ($1, $2, 'courier_shiprocket', $3, $4)`,
    [id, clientId, status, `${clientId}@ops.com`],
  );
}

async function addShipment(connId: string, clientId: string, awb: string, courier: string, status: string, orderedDaysAgo: number | null, deliveredDaysAgo: number | null = null) {
  await testPool.query(
    `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at, delivered_at)
     values ($1, $2, $3, $4, $5,
       case when $6::int is null then null else now() - ($6::int * interval '1 day') end,
       case when $7::int is null then null else now() - ($7::int * interval '1 day') end)`,
    [clientId, connId, awb, courier, status, orderedDaysAgo, deliveredDaysAgo],
  );
}

describe("GET /api/clients/:id/couriers/summary", () => {
  it("reports connected=false and empty data for a client without a courier", async () => {
    const res = await get("/api/clients/abc-fashion/couriers/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, statusCounts: {}, couriers: [] });
  });

  it("404s for a client the user cannot access", async () => {
    const res = await get("/api/clients/abc-fashion/couriers/summary", SCOPED, "scoped@agency.com");
    expect(res.status).toBe(404);
  });

  it("aggregates per courier and per status inside the window", async () => {
    await connectCourier(CONN, "abc-fashion");
    await addShipment(CONN, "abc-fashion", "D1", "Delhivery", "Delivered", 5, 3);
    await addShipment(CONN, "abc-fashion", "D2", "Delhivery", "RTO Initiated", 4);
    await addShipment(CONN, "abc-fashion", "D3", "Delhivery", "NDR", 2);
    await addShipment(CONN, "abc-fashion", "B1", "Bluedart", "Delivered", 6);
    await addShipment(CONN, "abc-fashion", "OLD", "Delhivery", "Delivered", 60, 55); // outside 30 days
    await addShipment(CONN, "abc-fashion", "NODATE", "Delhivery", "Delivered", null); // no order date: excluded

    const res = await get("/api/clients/abc-fashion/couriers/summary?days=30");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.statusCounts).toEqual({ Delivered: 2, "RTO Initiated": 1, NDR: 1 });
    expect(res.body.couriers).toEqual([
      { name: "Delhivery", orders: 3, delivered: 1, rtoPercent: 33.3, ndrPercent: 33.3, avgDeliveryDays: 2 },
      { name: "Bluedart", orders: 1, delivered: 1, rtoPercent: 0, ndrPercent: 0, avgDeliveryDays: null },
    ]);
  });

  it("does not count a disconnected courier as connected", async () => {
    await connectCourier(CONN, "abc-fashion", "disconnected");
    const res = await get("/api/clients/abc-fashion/couriers/summary");
    expect(res.body.connected).toBe(false);
  });

  it("clientId=all aggregates every accessible client and scoped users only see theirs", async () => {
    await connectCourier(CONN, "abc-fashion");
    await connectCourier(CONN_B, "xyz-beauty");
    await addShipment(CONN, "abc-fashion", "A1", "Delhivery", "Delivered", 3);
    await addShipment(CONN_B, "xyz-beauty", "X1", "Delhivery", "In Transit", 3);
    await addShipment(CONN_B, "xyz-beauty", "X2", "Delhivery", "In Transit", 3);

    const owner = await get("/api/clients/all/couriers/summary");
    expect(owner.body.couriers).toEqual([expect.objectContaining({ name: "Delhivery", orders: 3 })]);

    const scoped = await get("/api/clients/all/couriers/summary", SCOPED, "scoped@agency.com");
    expect(scoped.body.couriers).toEqual([expect.objectContaining({ name: "Delhivery", orders: 2 })]);
  });
});
```

Append to `server/test/routes/shopify-data.test.ts` (end of file):

```ts
describe("GET /api/clients/:id/sales rto_orders from shipments", () => {
  it("uses shipment RTO (by order date) instead of Shopify statuses once the client has shipments", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('66666666-6666-6666-6666-666666666666', 'abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com')`,
    );
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'A', now(), 500, 'RTO Initiated', 'COD'),
       ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'B', now(), 700, 'Delivered', 'Prepaid')`,
    );
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at) values
       ('abc-fashion', '66666666-6666-6666-6666-666666666666', 'S1', 'Delhivery', 'RTO Delivered', now()),
       ('abc-fashion', '66666666-6666-6666-6666-666666666666', 'S2', 'Delhivery', 'RTO Initiated', now()),
       ('abc-fashion', '66666666-6666-6666-6666-666666666666', 'S3', 'Delhivery', 'Delivered', now())`,
    );

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app).get("/api/clients/abc-fashion/sales?days=2").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const today = res.body[res.body.length - 1];
    expect(today.orders).toBe(2);
    expect(today.rtoOrders).toBe(2); // the two RTO shipments, not the one Shopify order labelled RTO
    expect(res.body[0].rtoOrders).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/courier-data.test.ts test/routes/shopify-data.test.ts`
Expected: FAIL (summary route 404; sales RTO count is 1 not 2).

- [ ] **Step 3: Add `resolveClientScope`**

Append to `server/src/lib/access.ts`:

```ts

// "all" aggregates every client the caller can see (the agency-wide dashboard view);
// anything else asserts access to that single client. Returns the client ids to query.
export async function resolveClientScope(db: pg.Pool, userId: string, clientId: string): Promise<string[]> {
  if (clientId === "all") {
    const accessible = await getAccessibleClientIds(db, userId);
    return accessible === "all" ? (await db.query<{ id: string }>("select id from clients")).rows.map((r) => r.id) : accessible;
  }
  await assertClientAccess(db, userId, clientId);
  return [clientId];
}
```

- [ ] **Step 4: Use it in `/sales` and add shipment-based RTO**

In `server/src/routes/shopify-data.ts`:

1. Add `resolveClientScope` to the import from `../lib/access.js`.
2. In the `/sales` handler replace the whole block from the comment `// "all" aggregates every client the caller can see (agency-wide dashboard view)` through the end of the `if (clientId === "all") { ... } else { ... }` statement (the `let clientIds: string[]; ...` declaration and the if/else that fills it) with:

```ts
    const clientIds = await resolveClientScope(pool, req.auth!.userId, clientId);
```

3. In the SQL, after the `ad_spend_by_day as ( ... )` CTE (add a comma after its closing parenthesis) add:

```sql
       shipment_rto_by_day as (
         select ordered_at::date as day, count(*) as rto_orders
         from shipments
         where client_id = any($1::text[])
           and status in ('RTO Initiated', 'RTO Delivered')
           and ordered_at >= current_date - ($2::int - 1)
         group by ordered_at::date
       ),
       has_shipments as (
         select exists (select 1 from shipments where client_id = any($1::text[])) as yes
       )
```

4. In the final `select`, replace the line `coalesce(orders_by_day.rto_orders, 0)::int as rto_orders` with

```sql
         (case when (select yes from has_shipments)
               then coalesce(shipment_rto_by_day.rto_orders, 0)
               else coalesce(orders_by_day.rto_orders, 0)
          end)::int as rto_orders
```

5. Add `left join shipment_rto_by_day on shipment_rto_by_day.day = days.day` next to the existing `left join ad_spend_by_day ...` line.
6. If `getAccessibleClientIds` is no longer referenced anywhere in the file, remove it from the import (check with grep).

- [ ] **Step 5: Create the summary router and mount it**

Create `server/src/routes/courier-data.ts`:

```ts
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveClientScope } from "../lib/access.js";

const router = Router({ mergeParams: true });

const RTO_STATUSES = "('RTO Initiated', 'RTO Delivered')";

router.get("/summary", requireAuth, async (req, res, next) => {
  try {
    const clientIds = await resolveClientScope(pool, req.auth!.userId, req.params.id);
    const days = Math.max(1, Math.min(730, Number(req.query.days) || 30));

    const [connected, byStatus, byCourier] = await Promise.all([
      pool.query(
        `select exists (
           select 1 from platform_connections
           where client_id = any($1::text[]) and left(platform, 8) = 'courier_' and status = 'connected'
         ) as connected`,
        [clientIds],
      ),
      pool.query(
        `select status, count(*)::int as count
         from shipments
         where client_id = any($1::text[]) and ordered_at >= now() - ($2::int * interval '1 day')
         group by status`,
        [clientIds, days],
      ),
      pool.query(
        `select
           courier_name as name,
           count(*)::int as orders,
           (count(*) filter (where status = 'Delivered'))::int as delivered,
           (count(*) filter (where status in ${RTO_STATUSES}))::int as rto,
           (count(*) filter (where status = 'NDR'))::int as ndr,
           avg(extract(epoch from (delivered_at - ordered_at)) / 86400)
             filter (where status = 'Delivered' and delivered_at is not null) as avg_days
         from shipments
         where client_id = any($1::text[]) and ordered_at >= now() - ($2::int * interval '1 day')
         group by courier_name
         order by orders desc, courier_name`,
        [clientIds, days],
      ),
    ]);

    const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

    res.json({
      connected: connected.rows[0].connected as boolean,
      statusCounts: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
      couriers: byCourier.rows.map((r) => ({
        name: r.name,
        orders: r.orders,
        delivered: r.delivered,
        rtoPercent: percent(r.rto, r.orders),
        ndrPercent: percent(r.ndr, r.orders),
        avgDeliveryDays: r.avg_days === null ? null : Math.round(Number(r.avg_days) * 10) / 10,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

In `server/src/index.ts` add `import courierDataRouter from "./routes/courier-data.js";` with the other router imports and, next to the other `/api/clients/:id/...` mounts (before `app.use("/api/couriers", couriersRouter);`), add:

```ts
app.use("/api/clients/:id/couriers", courierDataRouter);
```

- [ ] **Step 6: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/courier-data.test.ts test/routes/shopify-data.test.ts test/routes/couriers.test.ts`
Expected: all PASS, including the pre-existing `/sales` tests (the refactor to `resolveClientScope` and the SQL change must not alter them; the existing "counts RTO orders per day" test still passes because that client has no shipments).

- [ ] **Step 7: Commit**

```bash
git add server/src server/test/routes/courier-data.test.ts server/test/routes/shopify-data.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add courier summary endpoint and shipment-based RTO in sales

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Frontend — credentials dialog, hardened card, error-aware hooks

**Files:**
- Modify (full replacement): `src/lib/api.ts`
- Modify: `src/hooks/use-client-resource.ts`
- Modify (full replacement): `src/components/integrations/platforms.ts`
- Create: `src/components/integrations/credentials-dialog.tsx`
- Modify (full replacement): `src/components/integrations/integration-card.tsx`
- Modify (full replacement): `src/components/integrations/integrations-panel.tsx`

**Interfaces:**
- Consumes: backend `POST /api/clients/:id/connections/:platform/connect` (body `{ credentials: Record<string,string> }`), `.../authorize`, `DELETE .../:platform`, `GET .../connections`.
- Produces: `ApiError` with `status: number | null` and `code: string | null`; `useClientResource<T>()` now returns `{ data, loading, error }` (`error: boolean`, true when the last fetch failed; existing callers that destructure only `data`/`loading` are unaffected); `PlatformMeta` gains `authType: "oauth" | "credentials"` and optional `fields`; `PLATFORMS` (renamed from `OAUTH_PLATFORMS`, now four entries incl. Shiprocket); `pickConnection` stays exported from `platforms.ts`. `IntegrationCard` keeps its plan-1 props (it stays self-contained: no `onConnect`/`onDisconnect` split, decided here because both connect styles need the same busy/error handling).

Before starting, run `npm run lint 2>&1 | tail -5` and record the baseline warning count in your report; read the current versions of the six files first (they were created in plan 1; the replacements below are complete files).

- [ ] **Step 1: Replace `src/lib/api.ts`**

```ts
import { supabase } from "@/lib/supabase";

export class ApiError extends Error {
  status: number | null;
  code: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// Authenticated call to the backend. Throws ApiError with a message that is safe to show
// to the user: the server's own error message when it sent one, otherwise a generic one.
// `status`/`code` carry the HTTP status and the server's error code (e.g. "rate_limited",
// "credentials_rejected") so callers can branch on them.
export async function apiFetch(path: string, init: Omit<RequestInit, "headers"> = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new ApiError("You're not signed in. Please log in again.", 401, "unauthorized");
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
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    const code = typeof body?.error?.code === "string" ? body.error.code : null;
    throw new ApiError(message ?? `Request failed (${res.status}). Please try again.`, res.status, code);
  }
  return res;
}
```

- [ ] **Step 2: Add `error` to `useClientResource`**

In `src/hooks/use-client-resource.ts` change the signature and add error state:

1. Replace `export function useClientResource<T>(path: string | null, fallback: T): { data: T; loading: boolean } {` with `export function useClientResource<T>(path: string | null, fallback: T): { data: T; loading: boolean; error: boolean } {`.
2. Below `const [loading, setLoading] = React.useState(true);` add `const [error, setError] = React.useState(false);`.
3. In the effect, wherever `setLoading(true)` is called at the start of a fetch add `setError(false);` on the next line. In the `.then((json) => { if (!cancelled) setData(json); })` handler also call `setError(false)` inside the `if`. In the `.catch((err) => { console.error(err); if (!cancelled) setData(fallback); })` handler change the body to `console.error(err); if (!cancelled) { setData(fallback); setError(true); }`.
4. Change the last line to `return { data, loading, error };`.

(Keep every existing line otherwise as is, including the eslint-disable comment.)

- [ ] **Step 3: Replace `src/components/integrations/platforms.ts`**

```ts
import type * as React from "react";
import { Megaphone, Search, ShoppingBag, Truck } from "lucide-react";

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

// One field of a credentials form. `name` is the key sent to the backend's /connect endpoint.
export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "email" | "password";
  placeholder?: string;
}

export interface PlatformMeta {
  key: string;
  label: string;
  description: string;
  icon: React.ElementType;
  authType: "oauth" | "credentials";
  // oauth platforms that need input before the redirect
  input?: PlatformInput;
  // credentials platforms: the form to show
  fields?: CredentialField[];
  // credentials platforms: help text shown above the form
  helper?: string;
}

export const PLATFORMS: PlatformMeta[] = [
  {
    key: "shopify",
    label: "Shopify",
    description: "Orders, products and customers from the store",
    icon: ShoppingBag,
    authType: "oauth",
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
    authType: "oauth",
  },
  {
    key: "google",
    label: "Google Ads",
    description: "Campaigns and performance from Google Ads",
    icon: Search,
    authType: "oauth",
  },
  {
    key: "courier_shiprocket",
    label: "Shiprocket",
    description: "Shipments, delivery status, NDR and RTO by courier",
    icon: Truck,
    authType: "credentials",
    helper:
      "Create a separate API user in Shiprocket (Settings → API → Create API User) and enter its email and password here. Your main Shiprocket login won't work.",
    fields: [
      { name: "email", label: "API user email", type: "email", placeholder: "api-user@yourbrand.com" },
      { name: "password", label: "API user password", type: "password" },
    ],
  },
];

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
```

- [ ] **Step 4: Create `src/components/integrations/credentials-dialog.tsx`**

```tsx
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, apiFetch } from "@/lib/api";
import type { PlatformMeta } from "./platforms";

export function CredentialsDialog({
  open,
  onOpenChange,
  platform,
  clientId,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: PlatformMeta;
  clientId: string;
  onConnected: () => void;
}) {
  const fields = platform.fields ?? [];
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ready = fields.every((f) => (values[f.name] ?? "").trim().length > 0);

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next) {
      // Never keep a typed password around after the dialog closes.
      setValues({});
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/clients/${clientId}/connections/${platform.key}/connect`, {
        method: "POST",
        body: JSON.stringify({ credentials: values }),
      });
      setValues({});
      onOpenChange(false);
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to connect ${platform.label}. Please try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connect {platform.label}</DialogTitle>
            {platform.helper && <DialogDescription>{platform.helper}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-3 px-5 py-4">
            {fields.map((field) => (
              <label key={field.name} className="block text-[12px] font-medium text-text-secondary">
                {field.label}
                <Input
                  className="mt-1"
                  type={field.type}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  value={values[field.name] ?? ""}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }));
                    setError(null);
                  }}
                />
              </label>
            ))}
            {error && (
              <p role="alert" className="text-[12px] text-negative">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Replace `src/components/integrations/integration-card.tsx`**

```tsx
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { CredentialsDialog } from "./credentials-dialog";
import type { Connection, PlatformMeta } from "./platforms";

const STATUS_BADGE = {
  connected: { label: "Connected", variant: "positive" },
  error: { label: "Needs attention", variant: "warning" },
  disconnected: { label: "Not connected", variant: "neutral" },
} as const;

// The panel remounts a card (via `key`) whenever its connection status changes, so `busy`
// intentionally stays true after a successful disconnect until the refetched status arrives:
// there is no window in which a second click could send a second request.
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
  const [credentialsOpen, setCredentialsOpen] = React.useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

  const Icon = platform.icon;
  const status = connection?.status ?? "disconnected";
  const badge = STATUS_BADGE[status];
  const isConnected = status === "connected";
  const usesCredentials = platform.authType === "credentials";
  const needsInput = Boolean(platform.input) && !isConnected;
  const canConnect = !busy && (!needsInput || value.trim().length > 0);

  const connect = async () => {
    if (usesCredentials) {
      setCredentialsOpen(true);
      return;
    }
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
    setConfirmingDisconnect(false);
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/clients/${clientId}/connections/${platform.key}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to disconnect ${platform.label}. Please try again.`);
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
            aria-describedby={`${platform.key}-input-help`}
            className="h-8 text-[12px]"
          />
          <p id={`${platform.key}-input-help`} className="mt-1 text-[11px] text-text-tertiary">
            {platform.input.helper}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[11px] text-negative">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        {isConnected ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(true)} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={!canConnect}>
            {status === "error" ? "Reconnect" : "Connect"}
          </Button>
        )}
      </div>

      {usesCredentials && (
        <CredentialsDialog
          open={credentialsOpen}
          onOpenChange={setCredentialsOpen}
          platform={platform}
          clientId={clientId}
          onConnected={onChanged}
        />
      )}

      <Dialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect {platform.label}?</DialogTitle>
            <DialogDescription>
              Syncing stops and the stored access is deleted. Data already synced is kept.
              {usesCredentials ? " To reconnect you'll need to enter the credentials again." : " You can reconnect at any time."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDisconnect(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={disconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 6: Replace `src/components/integrations/integrations-panel.tsx`**

```tsx
import * as React from "react";
import { Button } from "@/components/ui/button";
import { useClientResource } from "@/hooks/use-client-resource";
import { IntegrationCard } from "./integration-card";
import { PLATFORMS, pickConnection, type Connection } from "./platforms";

const EMPTY_CONNECTIONS: Connection[] = [];

export function IntegrationsPanel({ clientId }: { clientId: string }) {
  // useClientResource refetches when its path changes; bumping this throwaway query param
  // after a connect/disconnect forces a reload (the server ignores unknown query params).
  const [version, setVersion] = React.useState(0);
  const {
    data: connections,
    loading,
    error,
  } = useClientResource<Connection[]>(`/api/clients/${clientId}/connections?v=${version}`, EMPTY_CONNECTIONS);

  if (loading && connections.length === 0) {
    return <p className="text-[11px] text-text-tertiary">Loading…</p>;
  }

  // A failed load must not look like "nothing is connected".
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-subtle p-3">
        <p role="alert" className="text-[12px] text-negative">
          Couldn't load this client's integrations.
        </p>
        <Button size="sm" variant="secondary" onClick={() => setVersion((v) => v + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {PLATFORMS.map((platform) => {
        const connection = pickConnection(connections, platform.key);
        return (
          <IntegrationCard
            // Remount when the status changes so per-card state (busy, typed input) resets
            // to match the freshly fetched connection.
            key={`${platform.key}:${connection?.status ?? "none"}`}
            platform={platform}
            connection={connection}
            clientId={clientId}
            onChanged={() => setVersion((v) => v + 1)}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 7: Verify build and lint**

Run: `npm run build`
Expected: succeeds. If `noUnusedLocals` reports anything (e.g. an import now unused), remove exactly that import. Ignore the pre-existing chunk-size warning.

Run: `npm run lint 2>&1 | tail -5`
Expected: warning count no higher than the baseline you recorded, and no warning from `src/components/integrations/*` or `src/lib/api.ts` or `src/hooks/use-client-resource.ts` that was not there before. If your change to `use-client-resource.ts` adds a `set-state-in-effect` warning, wrap ONLY the new `setError(false)` call in the existing style of that file (it already has an eslint-disable for exhaustive-deps; do not add blanket disables) or restructure so no new warning appears.

- [ ] **Step 8: Manual verification (honest reporting)**

If a Supabase session and backend are available, run the app and check: Manage Clients → a client shows four cards; Shiprocket "Connect" opens the dialog, Connect stays disabled until both fields are filled, a wrong password shows Shiprocket's rejection message inline, Disconnect asks for confirmation and the card flips without a second click being possible; forcing the `/connections` request to fail shows "Couldn't load this client's integrations" with a working "Try again". If they are not available, state explicitly which of these were NOT verified; do not claim them.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api.ts src/hooks/use-client-resource.ts src/components/integrations
git commit -m "$(cat <<'EOF'
feat: add credentials dialog, disconnect confirmation and load-error state to integrations

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Operations page on real courier data

**Files:**
- Modify: `src/data/types.ts` (add two types)
- Modify: `src/pages/operations.tsx`
- Modify: `src/data/mock.ts` (delete `getCourierBreakdown`)

**Interfaces:**
- Consumes: `GET /api/clients/:id/couriers/summary?days=N` (Task 7; `:id` may be `all`); `usePeriodData()` (returns `days`, `current`, `currentSum`, `previousSum`), `useClientResource` (returns `{ data, loading, error }`).
- Produces: `CourierStat` and `CourierSummary` exported from `src/data/types.ts`; the Operations page no longer imports `getCourierBreakdown`, and that mock export is deleted.

- [ ] **Step 1: Add the types**

Append to `src/data/types.ts`:

```ts

export interface CourierStat {
  name: string;
  orders: number;
  delivered: number;
  rtoPercent: number;
  ndrPercent: number;
  // null when no delivered shipment has both an order and a delivery date
  avgDeliveryDays: number | null;
}

export interface CourierSummary {
  // true when the client (or, for "all", any accessible client) has a connected courier
  connected: boolean;
  statusCounts: Record<string, number>;
  couriers: CourierStat[];
}
```

- [ ] **Step 2: Edit `src/pages/operations.tsx`**

Read the file first, then make these edits (line numbers are approximate):

1. **Imports.** Delete `import { getCourierBreakdown } from "@/data/mock";`. Change `import type { OrderStatus, GeoRow, Order } from "@/data/types";` to `import type { OrderStatus, GeoRow, Order, CourierSummary, CourierStat as CourierStatData } from "@/data/types";` (aliased because this file already defines a local `CourierStat` helper component). Add `import { Link } from "react-router-dom";` with the other imports.
2. **Constants.** Below `const EMPTY_GEO: GeoRow[] = [];` add:

```ts
const EMPTY_SUMMARY: CourierSummary = { connected: false, statusCounts: {}, couriers: [] };
```

3. **Top of the component.** Delete the line `const cid = isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion";`. Change `const { current, currentSum, previousSum } = usePeriodData();` to `const { days, current, currentSum, previousSum } = usePeriodData();`.
4. **Status counts and summary.** Replace the block from `const statusCounts = React.useMemo(() => {` through `const maxCount = Math.max(...Object.values(statusCounts), 1);` with:

```tsx
  const orderStatusCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return counts;
  }, [orders]);

  const summaryPath = isAllClients
    ? `/api/clients/all/couriers/summary?days=${days}`
    : client
      ? `/api/clients/${client.id}/couriers/summary?days=${days}`
      : null;
  const { data: summary, loading: summaryLoading } = useClientResource<CourierSummary>(summaryPath, EMPTY_SUMMARY);
  // Shipment statuses are the source of truth once a courier is connected; until then the
  // funnel falls back to the coarse statuses that Shopify orders carry.
  const statusCounts: Record<string, number> = summary.connected ? summary.statusCounts : orderStatusCounts;
  const maxCount = Math.max(...Object.values(statusCounts), 1);
```

5. **Couriers.** Replace `const couriers = React.useMemo(() => getCourierBreakdown(cid), [cid]);` with `const couriers = summary.couriers;` and change `React.useState<(typeof couriers)[number] | null>(null)` to `React.useState<CourierStatData | null>(null)`.
6. **Courier table body.** In the "Courier performance" card, change the average-days cell to
   `<td className="px-4 py-2 tabular-nums text-text-secondary">{c.avgDeliveryDays === null ? "—" : `${c.avgDeliveryDays}d`}</td>`
   and, directly after that card's closing `</table>` (still inside `<CardContent className="p-0">`), add:

```tsx
            {couriers.length === 0 && !summaryLoading && (
              <p className="px-4 py-6 text-center text-[12px] text-text-tertiary">
                {summary.connected ? (
                  "No shipments in this period."
                ) : (
                  <>
                    Connect a delivery partner to see courier performance.{" "}
                    <Link to="/manage-clients" className="text-brand hover:underline">
                      Manage integrations
                    </Link>
                  </>
                )}
              </p>
            )}
```

7. **`CourierDetailDialog`.** Change its prop type `courier: ReturnType<typeof getCourierBreakdown>[number] | null;` to `courier: CourierStatData | null;` and the average line to `<CourierStat label="Avg delivery time" value={courier.avgDeliveryDays === null ? "—" : `${courier.avgDeliveryDays}d`} />` (`CourierStat` there is the existing local helper component).

- [ ] **Step 3: Delete the mock**

In `src/data/mock.ts` delete the whole `export function getCourierBreakdown(clientId: string) { ... }` function (about 16 lines, directly above `const CAMPAIGN_NAMES`). Leave `COURIERS` (still used by the mock order generator) and everything else.

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: succeeds. Remove only imports/locals the compiler reports as unused (for example if `cid` or a helper is now unreferenced).

Run: `npm run lint 2>&1 | tail -5`
Expected: warning count no higher than the baseline recorded in Task 8; no new warnings from `src/pages/operations.tsx`.

Run: `grep -rn "getCourierBreakdown" src`
Expected: no matches.

- [ ] **Step 5: Manual verification (honest reporting)**

With a running backend and a client that has synced Shiprocket shipments (or rows inserted by hand into `shipments`), open Operations & RTO: the courier table lists real couriers with RTO % and average days ("—" when unknown); the delivery funnel and "NDR Orders" KPI use shipment statuses; the RTO % / RTO Orders KPIs and trend reflect shipment RTOs. A client with no courier shows "Connect a delivery partner…" with a working link; a connected client with no shipments in range shows "No shipments in this period."; "All clients" aggregates. State explicitly which of these you could not verify.

- [ ] **Step 6: Commit**

```bash
git add src/data/types.ts src/pages/operations.tsx src/data/mock.ts
git commit -m "$(cat <<'EOF'
feat: wire Operations courier table, funnel and NDR to real shipment data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Final verification, real-account checklist, graph refresh

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the whole server suite and type-check**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: type-check clean; every test file passes (expected stderr noise only: the scheduler test's "Shopify orders fetch failed: 500").

- [ ] **Step 2: Frontend checks**

Run: `npm run build && npm run lint 2>&1 | tail -5`
Expected: build succeeds; lint warning count not above the pre-plan baseline.

- [ ] **Step 3: Secrets check**

Run: `git grep -n "hunter2-secret\|pw-secret\|fake-token\|fresh-token" -- server/src src`
Expected: no matches (these strings exist only in tests).

- [ ] **Step 4: Refresh the knowledge graph**

Run: `graphify update .`
Expected: completes without error. Then `git status --short graphify-out | head`. If tracked graph files changed, commit only `graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json` (not dated snapshot folders and not `cache/`):

```bash
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json
git commit -m "$(cat <<'EOF'
chore: refresh graphify graph after Shiprocket integration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Write the real-account checklist into your report (do NOT run it without credentials)**

Plan 2 is not "done" until someone with a real Shiprocket API user has done the following against a dev database. List these in your final report as still-open items, in this order, and say plainly that none was performed:
1. Connect through the UI with the API user's email + password. Confirm the card shows Connected and a wrong password shows the inline rejection message.
2. Capture one real `POST /auth/login` response and one real `GET /orders?page=1&per_page=100` response (redact personal data). Compare against `shiprocket-api.ts`: base URL `https://apiv2.shiprocket.in/v1/external`, token field name, `data`/`meta.pagination.total_pages` envelope, order fields `channel_order_id`, `status`, `customer_state`, `created_at`, and `shipments[]` fields `awb`, `courier`, `status`, `delivered_date`. Fix `shiprocket-api.ts` and its fixtures in `shiprocket-api.test.ts` for any difference.
3. Confirm the page-size parameter (`per_page` vs `limit`), the sort order (newest first: the sync stops at the first all-old page), and the `created_at` date format (parsed with `Date.parse`; a wrong parse leaves `ordered_at` null and hides shipments from the summary).
4. Trigger "sync" (`POST /clients/:id/connections/courier_shiprocket/sync`) and check `select status, count(*) from shipments group by 1`. Check the server log for the warning `Shiprocket: unrecognized status labels treated as In Transit: ...` and extend `shiprocket-status.ts` (and its test table) for every real label listed.
5. Open Operations & RTO and cross-check one courier's order count and RTO % against Shiprocket's own dashboard for the same period.
6. Confirm the token lifetime question is moot (each sync logs in fresh) by checking two syncs more than 24 hours apart succeed.

- [ ] **Step 6: Report**

Summarize for the user: what shipped, exact test/build results, which manual checks in Tasks 8-9 were verified vs not, and the six open real-account items from Step 5.
