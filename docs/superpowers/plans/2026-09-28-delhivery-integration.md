# Delhivery Integration (Plan 3 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Shopify's own tracking-number data (confirmed real Shopify fields), and use it to let a client connect Delhivery with an API token and see those shipments' status in the same `shipments` table Shiprocket already populates — while being explicit that Delhivery's own API shape is unverified guesswork, not documented fact.

**Architecture:** Part A (Shopify) is low-risk and fully sourced from Context7's real Shopify Admin REST docs: the existing Shopify sync already fetches `fulfillments[]` in every order response, so a migration plus a small parsing change captures `tracking_number`/`tracking_company` with no new API calls. Part B (Delhivery) is a `courier_delhivery` credentials connector that, unlike Shiprocket, does **not** validate its token live (no confirmed endpoint to validate against) and has **no bulk discovery endpoint** (none confirmed to exist) — so its sync instead reads Shopify's captured tracking numbers for shipments that look like Delhivery's, tracks each by AWB via an isolated, explicitly-unsourced API module, and upserts into the same `shipments` table.

**Tech Stack:** Node/Express/TypeScript, `pg`, Vitest + Supertest (server); React 19 + Vite + Tailwind + Radix wrappers (frontend).

**Spec:** `docs/superpowers/specs/2026-09-27-simple-integrations-design.md` (plan 3 of its 5-plan rollout; amended 2026-09-28 for this plan — read its "Shopify tracking-number capture" and "Delhivery" sections before starting, they carry the full sourcing rationale this plan only summarizes)

## Global Constraints

- Server tests need a real Postgres: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run <files>`. Server type-check: `cd server && npx tsc --noEmit` (baseline clean, keep it clean).
- Frontend verification is `npm run build` and `npm run lint`; **no frontend test runner exists and this plan does not add one.** Before Task 5, record the lint baseline (`npm run lint 2>&1 | tail -5`); afterward the warning count must not exceed it and no new warning may come from a file this plan touches.
- Secrets: encrypted with `encryptToken`/`decryptToken` (`server/src/lib/crypto.ts`), never returned by any endpoint, never logged as a raw error object (log `err.message`).
- Errors use `HttpError(status, code, message)`; body `{ error: { code, message } }`. `CredentialsRejectedError` (`server/src/integrations/types.ts`) signals bad credentials to the `/connect` route.
- A sync must never resurrect a disconnected connection: every status-setting UPDATE carries `and status <> 'disconnected'`.
- `OrderStatus` / `shipments.status` values (exact strings): `Dispatched`, `In Transit`, `Out for Delivery`, `Delivered`, `NDR`, `RTO Initiated`, `RTO Delivered`, `Cancelled`.
- **What is and isn't sourced, exactly:**
  - Shopify's `order.fulfillments[].tracking_company` / `tracking_number` / `tracking_numbers[]` / `tracking_url` / `status` / `shipment_status` fields ARE confirmed (Context7, `shopify.dev` Admin REST API `order` resource, live sample JSON). Use these field names verbatim.
  - Delhivery's endpoint path, request format, response envelope, field names, and status vocabulary are **NOT confirmed by any source available this session** (Context7 returned only marketing overview text for every query). Every fact about Delhivery's actual API in this plan is general, publicly-known convention, presented AS SUCH — never claim it is documented. Isolate it entirely in `server/src/integrations/delhivery-api.ts` and `delhivery-status.ts`, exactly like Shiprocket's isolation pattern, parse defensively (unexpected shape throws, never writes wrong data), and do not let this uncertainty leak into any other file.
  - `shipments.status` check constraint, the `(client_id, awb)` uniqueness, and the courier connector interface are unchanged from plan 2 — no new migration needed for `shipments` itself.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` copied EXACTLY (never substitute your own model name).

---

### Task 1: Migration 009 — Shopify tracking-number columns

**Files:**
- Create: `server/migrations/009_shopify_tracking.sql`
- Create: `server/test/migration-009.test.ts`

**Interfaces:**
- Produces: `shopify_orders.tracking_number text` (nullable), `shopify_orders.tracking_company text` (nullable). Task 2 writes to these; Task 4's Delhivery sync reads them.

- [ ] **Step 1: Write the failing test**

Create `server/test/migration-009.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
});

describe("migration 009 (shopify tracking columns)", () => {
  it("stores a tracking number and company on a shopify order", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, tracking_number, tracking_company)
       values ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1', 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', 'AWB123', 'Delhivery Surface')`,
    );
    const res = await testPool.query("select tracking_number, tracking_company from shopify_orders");
    expect(res.rows).toEqual([{ tracking_number: "AWB123", tracking_company: "Delhivery Surface" }]);
  });

  it("both columns default to null", async () => {
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
       values ('abc-fashion', '55555555-5555-5555-5555-555555555555', '2', 'Amit Rao', now(), 500, 'Dispatched', 'COD')`,
    );
    const res = await testPool.query("select tracking_number, tracking_company from shopify_orders where shopify_order_id = '2'");
    expect(res.rows).toEqual([{ tracking_number: null, tracking_company: null }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-009.test.ts`
Expected: FAIL (`column "tracking_number" of relation "shopify_orders" does not exist`).

- [ ] **Step 3: Write the migration**

Create `server/migrations/009_shopify_tracking.sql`:

```sql
-- Confirmed via Shopify's Admin REST API `order` resource: each fulfillment carries
-- tracking_company / tracking_number. We capture the first fulfillment's values only
-- (a multi-fulfillment order only records one courier's tracking number — accepted gap).
alter table shopify_orders add column tracking_number text;
alter table shopify_orders add column tracking_company text;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-009.test.ts test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/009_shopify_tracking.sql server/test/migration-009.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add tracking_number and tracking_company columns to shopify_orders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Capture Shopify's tracking number and company during sync

**Files:**
- Modify: `server/src/integrations/shopify.ts` (the `ShopifyOrder` interface and the sync upsert)
- Modify: `server/test/integrations/shopify.test.ts` (add one test; read the file first to match its existing fixture/stub style exactly)

**Interfaces:**
- Consumes: migration 009's two columns.
- Produces: the Shopify sync upsert now writes `tracking_number`/`tracking_company` alongside the columns it already writes. No new exported symbols.

- [ ] **Step 1: Write the failing test**

Add these two tests inside the existing `describe("shopifyConnector.sync", ...)` block in `server/test/integrations/shopify.test.ts`, directly after the `"upserts orders and line items from the Shopify Orders API"` test (same `beforeEach` fixture — client `abc-fashion`, connection `55555555-5555-5555-5555-555555555555` — already applies):

```ts
  it("captures the first fulfillment's tracking number and company", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            orders: [
              {
                id: 1002,
                created_at: "2026-08-15T10:00:00Z",
                total_price: "999.00",
                financial_status: "paid",
                fulfillment_status: "fulfilled",
                cancelled_at: null,
                customer: { id: 9002, first_name: "Amit", last_name: "Rao" },
                shipping_address: { city: "Pune", province: "Maharashtra" },
                payment_gateway_names: ["shopify_payments"],
                line_items: [{ id: 502, title: "Linen Shirt", quantity: 1, price: "999.00" }],
                fulfillments: [
                  { tracking_company: "Delhivery Surface", tracking_number: "AWB123" },
                  { tracking_company: "Bluedart", tracking_number: "SHOULD_NOT_BE_USED" },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");

    const orders = await testPool.query("select tracking_number, tracking_company from shopify_orders where shopify_order_id = '1002'");
    expect(orders.rows).toEqual([{ tracking_number: "AWB123", tracking_company: "Delhivery Surface" }]);
  });

  it("leaves tracking columns null when there are no fulfillments yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            orders: [
              {
                id: 1003,
                created_at: "2026-08-15T10:00:00Z",
                total_price: "500.00",
                financial_status: "pending",
                fulfillment_status: null,
                cancelled_at: null,
                customer: { id: 9003, first_name: "Neha", last_name: "Kapoor" },
                shipping_address: { city: "Delhi", province: "Delhi" },
                payment_gateway_names: ["shopify_payments"],
                line_items: [{ id: 503, title: "Denim Jacket", quantity: 1, price: "500.00" }],
                // no `fulfillments` key at all — must not throw
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await shopifyConnector.sync("55555555-5555-5555-5555-555555555555");

    const orders = await testPool.query("select tracking_number, tracking_company from shopify_orders where shopify_order_id = '1003'");
    expect(orders.rows).toEqual([{ tracking_number: null, tracking_company: null }]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shopify.test.ts`
Expected: the two new tests FAIL (columns don't exist in the insert yet, so the query errors, or the assertion finds `undefined`).

- [ ] **Step 3: Parse and persist the fields**

In `server/src/integrations/shopify.ts`:

1. Add to the `ShopifyOrder` interface (after `line_items`):

```ts
  fulfillments?: { tracking_company: string | null; tracking_number: string | null }[];
```

2. Add a small helper directly above `mapOrderStatus`:

```ts
// Only the first fulfillment's tracking info is captured. A multi-fulfillment order (rare
// for this dashboard's D2C use case) only records the first courier's tracking number —
// accepted gap, not a bug.
function firstFulfillmentTracking(order: ShopifyOrder): { company: string | null; number: string | null } {
  const first = order.fulfillments?.[0];
  return { company: first?.tracking_company ?? null, number: first?.tracking_number ?? null };
}
```

3. In the `sync` method's loop, directly above the `orderResult` insert, add:

```ts
        const { company: trackingCompany, number: trackingNumber } = firstFulfillmentTracking(order);
```

4. Add `tracking_number` and `tracking_company` to the insert's column list and `values`/`do update set` clauses. The current insert reads:

```ts
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
```

Change it to:

```ts
        const orderResult = await pool.query(
          `insert into shopify_orders
             (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state, shopify_customer_id, tracking_number, tracking_company)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (connection_id, shopify_order_id)
           do update set customer_name = excluded.customer_name, amount = excluded.amount, status = excluded.status,
             payment_method = excluded.payment_method, city = excluded.city, state = excluded.state,
             tracking_number = excluded.tracking_number, tracking_company = excluded.tracking_company
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
            trackingNumber,
            trackingCompany,
          ],
        );
```

Make ONLY this edit and the two additions above — do not touch anything else in the file.

- [ ] **Step 4: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shopify.test.ts test/routes/shopify-data.test.ts test/scheduler.test.ts`
Expected: all PASS (existing Shopify tests unaffected — the new columns are additive).

- [ ] **Step 5: Commit**

```bash
git add server/src/integrations/shopify.ts server/test/integrations/shopify.test.ts
git commit -m "$(cat <<'EOF'
feat(server): capture Shopify fulfillment tracking number and company during sync

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Delhivery status mapper and API client (explicitly unsourced)

**Files:**
- Create: `server/src/integrations/delhivery-status.ts`
- Create: `server/src/integrations/delhivery-api.ts`
- Create: `server/test/integrations/delhivery-status.test.ts`
- Create: `server/test/integrations/delhivery-api.test.ts`

**Interfaces:**
- Produces (`delhivery-status.ts`): `mapDelhiveryStatus(raw: string | null | undefined): ShipmentStatus | null` (reuse the `ShipmentStatus` type — copy its 8-value union locally, do not import from `shiprocket-status.ts`, these modules must stay independent so a future correction to one never silently changes the other).
- Produces (`delhivery-api.ts`): `class DelhiveryAuthError extends Error`; `interface DelhiveryTrackedShipment { awb: string; status: string | null; statusType: string | null; destinationState: string | null }`; `trackShipment(token: string, awb: string): Promise<DelhiveryTrackedShipment | null>` (returns `null` if the AWB is simply not found/unrecognized by the API — distinct from an error). Task 4 consumes both.

- [ ] **Step 1: Write the failing status-mapper test**

Create `server/test/integrations/delhivery-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapDelhiveryStatus } from "../../src/integrations/delhivery-status.js";

// These labels are NOT sourced from any Delhivery documentation available this session —
// they are the general, publicly-known conventions used by Delhivery's status vocabulary.
// This test locks in this module's OWN behavior so a future correction (once real docs or
// a real account exist) has a clear, deliberate diff to review, not a silent behavior change.
describe("mapDelhiveryStatus", () => {
  it.each([
    ["Manifested", "Dispatched"],
    ["Pickup Scheduled", "Dispatched"],
    ["Pending", "Dispatched"],
    ["Picked Up", "In Transit"],
    ["In Transit", "In Transit"],
    ["Dispatched", "In Transit"],
    ["Out for Delivery", "Out for Delivery"],
    ["Delivered", "Delivered"],
    ["Undelivered", "NDR"],
    ["RTO", "RTO Initiated"],
    ["RTO Initiated", "RTO Initiated"],
    ["RTO In Transit", "RTO Initiated"],
    ["RTO Delivered", "RTO Delivered"],
    ["Cancelled", "Cancelled"],
    ["Canceled", "Cancelled"],
    ["  delivered  ", "Delivered"],
    ["rto delivered", "RTO Delivered"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapDelhiveryStatus(raw)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["   "], ["Lost In Transit"], ["Something Unexpected"]])(
    "returns null for %j",
    (raw) => {
      expect(mapDelhiveryStatus(raw as string | null | undefined)).toBeNull();
    },
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/delhivery-status.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the status mapper**

Create `server/src/integrations/delhivery-status.ts`:

```ts
// UNSOURCED: no Delhivery documentation was confirmed by any tool available this session
// (Context7 returned only marketing overview text for every query against Delhivery's
// developer portal). Every label below is a general, publicly-known convention about
// Delhivery's status vocabulary, not a documented fact. Confirm against a real account or
// real documentation before trusting this mapping — see the plan's Task 7 checklist.
export type ShipmentStatus =
  | "Dispatched"
  | "In Transit"
  | "Out for Delivery"
  | "Delivered"
  | "NDR"
  | "RTO Initiated"
  | "RTO Delivered"
  | "Cancelled";

const DISPATCHED_PARTS = ["MANIFEST", "PICKUP", "PENDING"];
const IN_TRANSIT_PARTS = ["IN TRANSIT", "PICKED UP", "DISPATCHED"];

export function mapDelhiveryStatus(raw: string | null | undefined): ShipmentStatus | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("RTO")) return s.includes("DELIVERED") ? "RTO Delivered" : "RTO Initiated";
  if (s.includes("CANCEL")) return "Cancelled";
  if (s.includes("UNDELIVERED") || s === "NDR") return "NDR";
  if (s.includes("OUT FOR DELIVERY")) return "Out for Delivery";
  if (s.includes("DELIVERED")) return "Delivered";
  if (IN_TRANSIT_PARTS.some((part) => s.includes(part))) return "In Transit";
  if (DISPATCHED_PARTS.some((part) => s.includes(part))) return "Dispatched";
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/delhivery-status.test.ts`
Expected: PASS (23 cases).

- [ ] **Step 5: Write the failing API-client test**

Create `server/test/integrations/delhivery-api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { trackShipment, DelhiveryAuthError } from "../../src/integrations/delhivery-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// UNSOURCED response shape (see delhivery-api.ts header comment) — this fixture is this
// module's own assumption about what track-by-waybill returns, not a documented sample.
const TRACK_FIXTURE = {
  ShipmentData: [
    {
      Shipment: {
        AWB: "AWB123",
        Status: { Status: "In Transit", StatusType: "UD" },
        Destination: "Maharashtra",
      },
    },
  ],
};

describe("trackShipment", () => {
  it("sends the token as an Authorization header and parses the response", async () => {
    const fetchMock = stubFetch(TRACK_FIXTURE);
    const result = await trackShipment("tok-1", "AWB123");
    expect(result).toEqual({ awb: "AWB123", status: "In Transit", statusType: "UD", destinationState: "Maharashtra" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("AWB123");
    expect((init.headers as Record<string, string>).Authorization).toContain("tok-1");
  });

  it("returns null when the shipment list is empty (AWB not found)", async () => {
    stubFetch({ ShipmentData: [] });
    expect(await trackShipment("tok-1", "UNKNOWN")).toBeNull();
  });

  it("throws DelhiveryAuthError on 401", async () => {
    stubFetch({}, 401);
    await expect(trackShipment("bad-token", "AWB123")).rejects.toBeInstanceOf(DelhiveryAuthError);
  });

  it("throws a plain error on a server failure", async () => {
    stubFetch({}, 500);
    const err = await trackShipment("tok-1", "AWB123").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DelhiveryAuthError);
  });

  it("throws on an unexpected response shape rather than guessing", async () => {
    stubFetch({ unexpected: true });
    await expect(trackShipment("tok-1", "AWB123")).rejects.toThrow(/unexpected/i);
  });

  it("tolerates a missing Status or Destination without throwing", async () => {
    stubFetch({ ShipmentData: [{ Shipment: { AWB: "AWB999" } }] });
    expect(await trackShipment("tok-1", "AWB999")).toEqual({
      awb: "AWB999",
      status: null,
      statusType: null,
      destinationState: null,
    });
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/delhivery-api.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the API client**

Create `server/src/integrations/delhivery-api.ts`:

```ts
// UNSOURCED: no Delhivery API documentation was confirmed by any tool available this
// session — Context7 returned only marketing overview text for the developer portal, and
// the docs site itself does not render for a non-browser fetch. Every URL, header, and
// field name below is a general, publicly-known convention about Delhivery's track-by-
// waybill API, presented here as an ASSUMPTION, never as documented fact. It is isolated
// to this file and parsed defensively (an unexpected shape throws, never silently
// produces wrong data) precisely so a wrong assumption is cheap to find and fix in one
// place. Confirm against a real Delhivery account or real documentation before relying on
// it — see the plan's Task 7 checklist.
const TRACK_URL = "https://track.delhivery.com/api/v1/packages/json/";

// Bad/expired token. Distinct from a transient failure so callers can ask the user to
// reconnect instead of retrying.
export class DelhiveryAuthError extends Error {}

export interface DelhiveryTrackedShipment {
  awb: string;
  status: string | null;
  statusType: string | null;
  destinationState: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Returns null when the AWB is simply not recognized by the API (an empty ShipmentData
// list) — that is a normal, expected outcome, not an error.
export async function trackShipment(token: string, awb: string): Promise<DelhiveryTrackedShipment | null> {
  const url = `${TRACK_URL}?waybill=${encodeURIComponent(awb)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new DelhiveryAuthError("Delhivery rejected the API token");
  }
  if (!res.ok) {
    throw new Error(`Delhivery track request failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.ShipmentData)) {
    throw new Error("Delhivery returned an unexpected tracking response (no ShipmentData array)");
  }
  if (body.ShipmentData.length === 0) return null;

  const entry = body.ShipmentData[0];
  const shipment = isRecord(entry) && isRecord(entry.Shipment) ? entry.Shipment : null;
  if (!shipment) {
    throw new Error("Delhivery returned an unexpected tracking response (no Shipment object)");
  }
  const status = isRecord(shipment.Status) ? shipment.Status : null;
  return {
    awb: asString(shipment.AWB) ?? awb,
    status: status ? asString(status.Status) : null,
    statusType: status ? asString(status.StatusType) : null,
    destinationState: asString(shipment.Destination),
  };
}
```

- [ ] **Step 8: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/delhivery-status.test.ts test/integrations/delhivery-api.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/integrations/delhivery-status.ts server/src/integrations/delhivery-api.ts server/test/integrations/delhivery-status.test.ts server/test/integrations/delhivery-api.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add Delhivery status mapper and API client (unsourced, isolated)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Delhivery connector, registry, couriers list, scheduler

**Files:**
- Create: `server/src/integrations/delhivery.ts`
- Modify: `server/src/lib/connector-registry.ts`
- Modify: `server/src/routes/couriers.ts`
- Modify: `server/src/scheduler.ts`
- Create: `server/test/integrations/delhivery.test.ts`
- Modify: `server/test/routes/couriers.test.ts`
- Modify: `server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `CredentialsConnector`, `CredentialsRejectedError` (`types.ts`); `trackShipment`, `DelhiveryAuthError`, `DelhiveryTrackedShipment` (Task 3); `mapDelhiveryStatus` (Task 3); `tracking_number`/`tracking_company` on `shopify_orders` (Tasks 1-2); the `shipments` table (unchanged from plan 2: `id, client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at, delivered_at, synced_at`, `unique (client_id, awb)` since migration 008).
- Produces: `delhiveryConnector: CredentialsConnector` (platform `"courier_delhivery"`) registered in `connectors`; `GET /api/couriers` marks Delhivery `available: true`; hourly scheduled sync for `courier_delhivery`.

- [ ] **Step 1: Write the failing connector tests**

Create `server/test/integrations/delhivery.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";
import { delhiveryConnector } from "../../src/integrations/delhivery.js";
import { CredentialsRejectedError } from "../../src/integrations/types.js";

const CONN = "88888888-8888-8888-8888-888888888888";
const SHOPIFY_CONN = "55555555-5555-5555-5555-555555555555";
const TOKEN = "tok-secret";

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

async function insertConnection(status = "connected", credentials: object | null = { token: TOKEN }) {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, credentials, external_account_id)
     values ($1, 'abc-fashion', 'courier_delhivery', $2, $3, $4, 'delhivery-token')`,
    [CONN, status, encryptToken(TOKEN), credentials ? encryptToken(JSON.stringify(credentials)) : null],
  );
}

async function insertShopifyConnection() {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${SHOPIFY_CONN}', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
}

async function insertShopifyOrder(orderId: string, trackingNumber: string | null, trackingCompany: string | null) {
  await testPool.query(
    `insert into shopify_orders
       (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, tracking_number, tracking_company)
     values ('abc-fashion', '${SHOPIFY_CONN}', $1, 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', $2, $3)`,
    [orderId, trackingNumber, trackingCompany],
  );
}

function stubDelhivery(responses: Record<string, unknown> | ((awb: string) => unknown), status = 200) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const awb = new URL(url).searchParams.get("waybill") ?? "";
    const body = typeof responses === "function" ? responses(awb) : (responses[awb] ?? { ShipmentData: [] });
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("delhiveryConnector.connectWithCredentials", () => {
  it("accepts a non-blank token without calling Delhivery live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await delhiveryConnector.connectWithCredentials("abc-fashion", { token: "  my-token  ", evil: "drop me" });
    expect(result).toEqual({ externalAccountId: "delhivery-token", accessToken: "my-token", credentials: { token: "my-token" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a blank token", async () => {
    await expect(delhiveryConnector.connectWithCredentials("abc-fashion", { token: "   " })).rejects.toBeInstanceOf(
      CredentialsRejectedError,
    );
  });
});

describe("delhiveryConnector.sync", () => {
  it("tracks Shopify orders whose tracking company mentions Delhivery and upserts shipments", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    await insertShopifyOrder("1002", "AWB2", "delhivery air");
    await insertShopifyOrder("1003", "TRACK3", "Bluedart"); // not Delhivery — must be ignored
    await insertShopifyOrder("1004", null, null); // no tracking — must be ignored

    stubDelhivery({
      AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered", StatusType: "DL" }, Destination: "Maharashtra" } }] },
      AWB2: { ShipmentData: [{ Shipment: { AWB: "AWB2", Status: { Status: "In Transit", StatusType: "UD" }, Destination: "Karnataka" } }] },
    });

    const result = await delhiveryConnector.sync(CONN);
    expect(result).toEqual({ recordsSynced: 2 });

    const rows = (
      await testPool.query("select awb, status, courier_name, destination_state from shipments order by awb")
    ).rows;
    expect(rows).toEqual([
      { awb: "AWB1", status: "Delivered", courier_name: "Delhivery", destination_state: "Maharashtra" },
      { awb: "AWB2", status: "In Transit", courier_name: "Delhivery", destination_state: "Karnataka" },
    ]);
    const conn = (await testPool.query("select status, last_synced_at from platform_connections where id = $1", [CONN])).rows[0];
    expect(conn.status).toBe("connected");
    expect(conn.last_synced_at).not.toBeNull();
  });

  it("is idempotent and updates status on the next run", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");

    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "In Transit" } } }] } });
    await delhiveryConnector.sync(CONN);
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered" } } }] } });
    await delhiveryConnector.sync(CONN);

    expect((await testPool.query("select status from shipments")).rows).toEqual([{ status: "Delivered" }]);
  });

  it("skips a shipment already terminal, without calling Delhivery for it again", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at) values
       ('abc-fashion', '${CONN}', 'AWB1', 'Delhivery', 'Delivered', now())`,
    );
    const fetchMock = stubDelhivery({});
    await delhiveryConnector.sync(CONN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the AWB unaltered when Delhivery finds nothing for it (still marks synced)", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({}); // empty ShipmentData for every AWB
    const result = await delhiveryConnector.sync(CONN);
    expect(result).toEqual({ recordsSynced: 0 });
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });

  it("falls back to In Transit and warns once for an unrecognized status label", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Something Unexpected" } } }] } });
    await delhiveryConnector.sync(CONN);
    expect((await testPool.query("select status from shipments")).rows).toEqual([{ status: "In Transit" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Something Unexpected");
  });

  it("fails clearly and writes nothing when the stored token is rejected", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({}, 401);
    await expect(delhiveryConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });

  it("fails when the connection has no stored credentials", async () => {
    await insertConnection("connected", null);
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    await expect(delhiveryConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
  });

  it("does not resurrect a disconnected connection", async () => {
    await insertConnection("disconnected");
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered" } } }] } });
    await delhiveryConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections where id = $1", [CONN])).rows[0].status).toBe(
      "disconnected",
    );
  });

  it("recovers a connection stuck in error", async () => {
    await insertConnection("error");
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered" } } }] } });
    await delhiveryConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections where id = $1", [CONN])).rows[0].status).toBe(
      "connected",
    );
  });
});

describe("delhiveryConnector.disconnect", () => {
  it("marks the connection disconnected", async () => {
    await insertConnection();
    await delhiveryConnector.disconnect(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("disconnected");
  });
});
```

Modify `server/test/routes/couriers.test.ts`: replace the second test with

```ts
  it("lists known couriers, Shiprocket and Delhivery available", async () => {
    const token = signTestJwt({ sub: "any-user", email: "someone@agency.com" });
    const res = await request(app).get("/api/couriers").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "courier_shiprocket", name: "Shiprocket", available: true },
      { id: "courier_delhivery", name: "Delhivery", available: true },
      { id: "courier_shadowfax", name: "Shadowfax", available: false },
    ]);
  });
```

In `server/test/scheduler.test.ts`, append inside `describe("startScheduler", ...)`:

```ts
  it("schedules an hourly Delhivery sync at minute 30", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("30 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/delhivery.test.ts test/routes/couriers.test.ts test/scheduler.test.ts`
Expected: FAIL (connector module missing; couriers list and scheduler assertions differ).

- [ ] **Step 3: Implement the connector**

Create `server/src/integrations/delhivery.ts`:

```ts
import type { CredentialsConnector } from "./types.js";
import { CredentialsRejectedError } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
import { trackShipment, DelhiveryAuthError } from "./delhivery-api.js";
import { mapDelhiveryStatus } from "./delhivery-status.js";

// Bounds one hourly sync's work — Delhivery has no confirmed bulk endpoint, so this
// connector tracks one AWB per HTTP call; without a cap a client with a large backlog of
// Delhivery-flagged Shopify orders could make the hourly sync run very long.
const MAX_TRACKED_PER_SYNC = 200;
const TERMINAL_STATUSES = new Set(["Delivered", "RTO Delivered", "Cancelled"]);

const RECONNECT_MESSAGE = "Delhivery rejected the stored API token. Reconnect with a current token.";

export const delhiveryConnector: CredentialsConnector = {
  platform: "courier_delhivery",
  authType: "credentials",

  async connectWithCredentials(_clientId, credentials) {
    // Whitelist to just the one field this connector uses; anything else is dropped.
    const token = (credentials.token ?? "").trim();
    if (!token) {
      throw new CredentialsRejectedError("Enter your Delhivery API token.");
    }
    // Deliberately does NOT call Delhivery here: no endpoint is confirmed to validate a
    // token against (see the module header in delhivery-api.ts). The token is accepted as
    // entered; the first sync reveals whether it works and puts the connection in `error`
    // if not — the same outcome a live check would have produced, one cycle later.
    return { externalAccountId: token, accessToken: token, credentials: { token } };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query("select client_id, credentials from platform_connections where id = $1", [
      connectionId,
    ]);
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    if (!conn.credentials) {
      throw new Error("This Delhivery connection has no stored credentials. Reconnect it.");
    }
    const { token } = JSON.parse(decryptToken(conn.credentials)) as { token: string };

    // Discover candidate AWBs: Shopify orders for this client whose tracking company looks
    // like Delhivery, that either have no shipments row yet or whose existing row isn't
    // terminal — never AWBs synced by a different courier connection.
    const candidates = await pool.query<{ tracking_number: string; shopify_order_id: string }>(
      `select o.tracking_number, o.shopify_order_id
       from shopify_orders o
       left join shipments s on s.client_id = o.client_id and s.awb = o.tracking_number
       where o.client_id = $1
         and o.tracking_company ilike '%delhivery%'
         and o.tracking_number is not null
         and (s.awb is null or s.status not in ('Delivered', 'RTO Delivered', 'Cancelled'))
       order by o.order_date desc
       limit $2`,
      [conn.client_id, MAX_TRACKED_PER_SYNC],
    );

    const unmapped = new Set<string>();
    let recordsSynced = 0;

    for (const { tracking_number: awb, shopify_order_id: orderRef } of candidates.rows) {
      let tracked;
      try {
        tracked = await trackShipment(token, awb);
      } catch (err) {
        if (err instanceof DelhiveryAuthError) throw new Error(RECONNECT_MESSAGE);
        throw err;
      }
      if (!tracked) continue; // AWB not (yet) recognized by Delhivery — try again next sync

      const mapped = mapDelhiveryStatus(tracked.status);
      if (!mapped && tracked.status) unmapped.add(tracked.status);

      await pool.query(
        `insert into shipments (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at)
         values ($1, $2, $3, $4, 'Delhivery', $5, $6, now())
         on conflict (client_id, awb)
         do update set connection_id = excluded.connection_id, order_ref = excluded.order_ref,
           status = excluded.status, destination_state = excluded.destination_state, synced_at = now()`,
        [conn.client_id, connectionId, tracked.awb, orderRef, mapped ?? "In Transit", tracked.destinationState],
      );
      recordsSynced++;
    }

    if (unmapped.size > 0) {
      console.warn(`Delhivery: unrecognized status labels treated as In Transit: ${[...unmapped].join(", ")}`);
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

In `server/src/lib/connector-registry.ts` add `import { delhiveryConnector } from "../integrations/delhivery.js";` and the entry `courier_delhivery: delhiveryConnector,`.

In `server/src/routes/couriers.ts` change `{ id: "courier_delhivery", name: "Delhivery", available: false }` to `{ id: "courier_delhivery", name: "Delhivery", available: true }` (leave Shadowfax's entry unchanged).

In `server/src/scheduler.ts`, at the end of `startScheduler()` (after the Shiprocket schedule added in plan 2), add:

```ts

  // Same hourly cadence, offset to minute 30 so Shopify (:00), Shiprocket (:15) and
  // Delhivery (:30) don't hit the database in the same minute.
  cron.schedule(
    "30 * * * *",
    () => {
      runScheduledSyncs("courier_delhivery").catch((err) => console.error("Delhivery scheduled sync failed:", err));
    },
    { noOverlap: true },
  );
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/delhivery.test.ts test/routes/couriers.test.ts test/scheduler.test.ts test/routes/connections-framework.test.ts test/routes/courier-data.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/delhivery.ts server/src/lib/connector-registry.ts server/src/routes/couriers.ts server/src/scheduler.ts server/test/integrations/delhivery.test.ts server/test/routes/couriers.test.ts server/test/scheduler.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add Delhivery connector, discovered via Shopify tracking numbers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Route-level test through the real Delhivery connector

**Files:**
- Create: `server/test/routes/connect-delhivery.test.ts`

**Interfaces:**
- Consumes: the real `courier_delhivery` connector registered in Task 4, `POST /connect`, `POST /:platform/sync`. No production code changes; proves the whole path (route → connector → `saveConnection` → sync → `shipments`).

- [ ] **Step 1: Write the test**

Create `server/test/routes/connect-delhivery.test.ts`:

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
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
  await testPool.query(
    `insert into shopify_orders
       (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, tracking_number, tracking_company)
     values ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1001', 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', 'AWB1', 'Delhivery Surface')`,
  );
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubDelhivery() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "In Transit" } } }] }), { status: 200 })),
  );
}

const connect = (credentials: unknown) =>
  request(app)
    .post("/api/clients/abc-fashion/connections/courier_delhivery/connect")
    .set("Authorization", `Bearer ${token()}`)
    .send({ credentials });

describe("connecting Delhivery end to end", () => {
  it("connects without a live call, then a manual sync writes shipments from Shopify tracking numbers", async () => {
    const res = await connect({ token: "my-secret-token" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "courier_delhivery", status: "connected", externalAccountId: "my-secret-token" });

    const row = (await testPool.query("select credentials from platform_connections where platform = 'courier_delhivery'")).rows[0];
    expect(JSON.parse(decryptToken(row.credentials))).toEqual({ token: "my-secret-token" });
    expect(row.credentials).not.toContain("my-secret-token");

    stubDelhivery();
    const sync = await request(app)
      .post("/api/clients/abc-fashion/connections/courier_delhivery/sync")
      .set("Authorization", `Bearer ${token()}`);
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ recordsSynced: 1 });
    expect((await testPool.query("select awb, status, courier_name from shipments")).rows).toEqual([
      { awb: "AWB1", status: "In Transit", courier_name: "Delhivery" },
    ]);
  });

  it("rejects a blank token with no connection created", async () => {
    const res = await connect({ token: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("credentials_rejected");
    expect((await testPool.query("select 1 from platform_connections where platform = 'courier_delhivery'")).rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/connect-delhivery.test.ts`
Expected: PASS (2 tests). If it fails, that reveals a real integration bug in Tasks 1-4: fix the production code responsible (never the test) and document it in your report.

- [ ] **Step 3: Commit**

```bash
git add server/test/routes/connect-delhivery.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover Delhivery connect and manual sync through the routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — add Delhivery to the Integrations panel

**Files:**
- Modify: `src/components/integrations/platforms.ts` (add one entry to `PLATFORMS`)

**Interfaces:**
- Consumes: `PlatformMeta`, `CredentialField` (already exported by this file, from plan 2). No other frontend file needs to change — `IntegrationCard`, `IntegrationsPanel`, and `CredentialsDialog` are already data-driven off `PLATFORMS`.

- [ ] **Step 1: Record the lint baseline**

Run: `npm run lint 2>&1 | tail -5` and note the warning count.

- [ ] **Step 2: Add the Delhivery entry**

Read `src/components/integrations/platforms.ts` first. In the `PLATFORMS` array, add a new object after the `courier_shiprocket` entry (before the closing `];`):

```ts
  {
    key: "courier_delhivery",
    label: "Delhivery",
    description: "Shipments, delivery status, NDR and RTO by courier",
    icon: Truck,
    authType: "credentials",
    helper:
      "Paste your Delhivery API token (from the Delhivery portal). Delhivery has no bulk order list, so shipments are matched from the tracking numbers your Shopify orders already carry — connect Shopify first for this to find anything.",
    fields: [{ name: "token", label: "API token", type: "password" }],
  },
```

Do not change any other file — `PLATFORMS` already drives the card, the credentials dialog, and the disconnect flow generically.

- [ ] **Step 3: Verify**

Run: `npm run build`
Expected: succeeds (no new imports needed — `Truck` is already imported in this file for the Shiprocket entry).

Run: `npm run lint 2>&1 | tail -5`
Expected: warning count no higher than the baseline from Step 1; no new warning from `platforms.ts`.

- [ ] **Step 4: Manual verification (honest reporting)**

If a Supabase session and backend are available: open Manage Clients → a client → Integrations, confirm a "Delhivery" card appears with a "Connect" button that opens a dialog with one password-type "API token" field and the helper text above, and that entering any non-blank token and submitting shows the card as Connected. If not available, state explicitly that this was NOT verified — do not claim it.

- [ ] **Step 5: Commit**

```bash
git add src/components/integrations/platforms.ts
git commit -m "$(cat <<'EOF'
feat: add Delhivery to the Integrations panel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification, real-account checklist, graph refresh

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the whole server suite and type-check**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: type-check clean; every test file passes (expected stderr noise only: the scheduler test's Shopify/Shiprocket failure simulations, and any intentional negative-path connect-failure logs).

- [ ] **Step 2: Frontend checks**

Run: `npm run build && npm run lint 2>&1 | tail -5`
Expected: build succeeds; lint warning count not above the pre-plan baseline.

- [ ] **Step 3: Secrets check**

Run: `git grep -n "my-secret-token\|tok-secret\|pw-secret\|fake-token\|fresh-token" -- server/src src`
Expected: no matches outside test files (these strings exist only in tests).

- [ ] **Step 4: Refresh the knowledge graph**

Run: `graphify update .`
Expected: completes without error. Then `git status --short graphify-out | head`. If tracked files changed, commit only `graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json` (never dated snapshot folders, never `cache/`):

```bash
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json
git commit -m "$(cat <<'EOF'
chore: refresh graphify graph after Delhivery integration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Write the real-account / real-docs checklist into your report (do NOT attempt to run it without credentials or documentation)**

This plan is riskier than plan 2's Shiprocket work: plan 2 at least had Shiprocket's own login and orders-list endpoints confirmed by Context7. Delhivery here has ZERO confirmed endpoints. List these as still-open items in your final report, in this order, and say plainly none was performed:

1. **Get real Delhivery documentation or a real account before trusting any Delhivery-derived number.** This is the precondition for everything below — without it, items 2-6 cannot be done at all, only guessed at again.
2. Confirm the real track endpoint's URL, method, and auth header format against `delhivery-api.ts`'s assumption (`GET https://track.delhivery.com/api/v1/packages/json/?waybill=...&token=...` with an `Authorization: Token <token>` header). Fix the module and its test fixtures for any difference.
3. Confirm the response envelope (`ShipmentData[].Shipment.{AWB, Status.{Status, StatusType}, Destination}`) against a real response. Redact personal data when capturing a sample.
4. Capture the real status vocabulary and extend `delhivery-status.ts`'s mapping (and its test table) for every real label — the server log's `Delhivery: unrecognized status labels treated as In Transit: ...` warning is where unmapped labels will show up once real data flows.
5. Connect through the UI with a real token; confirm a wrong token surfaces as `error` on the first sync (not at connect time — that's this plan's deliberate design, see the spec).
6. Cross-check the "tracking company mentions Delhivery" match (`tracking_company ilike '%delhivery%'`) against how a real Shopify order created by a real Delhivery shipment actually labels `tracking_company` — the exact string Shopify stores depends on what the merchant's fulfillment app writes, and might not contain the word "Delhivery" at all.
7. Confirm whether Delhivery's real API supports tracking multiple AWBs in one call — if so, `delhivery.ts`'s one-AWB-per-request loop is an easy follow-up optimization, not a correctness fix.

- [ ] **Step 6: Report**

Summarize for the user: what shipped, exact test/build results, which manual states in Task 6 were verified vs not, and the seven-item real-docs-and-account checklist from Step 5 — emphasizing that item 1 blocks all the others and that, unlike Shiprocket, nothing about Delhivery's actual behavior has been confirmed at all.
