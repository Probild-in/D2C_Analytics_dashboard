# Shopify Install-Link Flow (Plan 5 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant can click a link an agency shares with them (`.../api/integrations/shopify/install?shop=mystore`), approve access on Shopify's own screen with no dashboard login required, and a logged-in team member then picks which client the store belongs to — completing the last of the five integration plans.

**Architecture:** This is the smallest plan in the series. `shopifyConnector.handleCallback` needs **zero changes** — Shopify's OAuth always yields exactly one shop, so it always returns `{type: "connected", ...}` regardless of why the flow started. The branching lives one layer up, in the callback route: if the signed state token carries a known `clientId` (every existing flow), behavior is completely unchanged; if not (only the new install route can produce this), the route stores the result in `pending_connections` instead of saving it immediately. A new `claim` action on plan 4's `pending-connections` router — reusing its `lockPendingForUpdate` locking, since a claim needs the same atomicity plan 4's select needed — lets the logged-in user finish the connection.

**Tech Stack:** Node/Express/TypeScript, `pg`, `jose` (JWT), Vitest + Supertest (server); React 19 + Vite + React Router (frontend).

**Spec:** `docs/superpowers/specs/2026-09-27-simple-integrations-design.md` (plan 5 of its 5-plan rollout, the last one; amended 2026-09-29 for this plan — read its finalized "Plan 5, install link" section, which carries the full design rationale this plan only summarizes)

## Global Constraints

- Server tests need a real Postgres: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run <files>`. Server type-check: `cd server && npx tsc --noEmit` (baseline clean, keep it clean).
- Frontend verification is `npm run build` and `npm run lint 2>&1 | grep -c "warning"` (use `grep -c`, never `tail -N` — a mistake caught twice already this session). **No frontend test runner exists and this plan does not add one.**
- `shopifyConnector.handleCallback` (`server/src/integrations/shopify.ts`) is NOT touched by this plan. If any task's implementation seems to require changing it, stop and report — that would mean the design assumption above is wrong.
- The install route (`GET /api/integrations/shopify/install`) is deliberately PUBLIC — no `requireAuth`. It is not linked from anywhere inside the dashboard; it only exists as a URL an agency shares out-of-band. `POST /:id/claim` IS behind `requireAuth` — that is where a logged-in identity first enters the flow.
- A claim-time access failure (`assertClientAccess` on the CHOSEN client) is a genuine, distinct error — NOT folded into the undifferentiated `pending_expired` the way plan 4's `GET`/`select` handle an access failure. The person on the claim page already knows the link is real (the page loaded and shows a shop domain); the "never confirm a stale link was ever valid" concern doesn't apply once the row's existence is already established.
- `pending_connections.payload.shop` (declared in plan 4's `PendingPayload` interface, never populated until now) carries the shop domain for this flow's rows. Reuse `lockPendingForUpdate` from `server/src/lib/pending-connections.ts` (plan 4) for the claim's atomicity — do not write a second unlocked read-then-write sequence.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` copied EXACTLY (never substitute your own model name).

---

### Task 1: `StatePayload` — `clientId` and `teamMemberId` become optional

**Files:**
- Modify: `server/src/lib/state-token.ts`
- Modify: `server/test/lib/state-token.test.ts`

**Interfaces:**
- Produces: `StatePayload { clientId?: string; platform: string; teamMemberId?: string; shopDomain?: string; }`. `signState`/`verifyState` round-trip a payload with either field omitted. Task 2 (the install route) and Task 3 (the callback route) rely on this.

- [ ] **Step 1: Write the failing test**

Add this test to `server/test/lib/state-token.test.ts`, inside the existing `describe("state-token", ...)` block:

```ts
  it("round-trips a state with no clientId or teamMemberId (the install-link case)", async () => {
    const token = await signState({ platform: "shopify", shopDomain: "abc-fashion.myshopify.com" });
    const payload = await verifyState(token);
    expect(payload).toMatchObject({ platform: "shopify", shopDomain: "abc-fashion.myshopify.com" });
    expect(payload.clientId).toBeUndefined();
    expect(payload.teamMemberId).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/state-token.test.ts`
Expected: FAIL — a TypeScript compile error (the call site is missing required `clientId`/`teamMemberId`), which vitest reports as a test-file load failure.

- [ ] **Step 3: Make the fields optional**

In `server/src/lib/state-token.ts`, change the `StatePayload` interface from:

```ts
export interface StatePayload {
  clientId: string;
  platform: string;
  teamMemberId: string;
  shopDomain?: string;
}
```

to:

```ts
export interface StatePayload {
  clientId?: string;
  platform: string;
  teamMemberId?: string;
  shopDomain?: string;
}
```

Then in `verifyState`, change the two casts from `as string` to `as string | undefined`:

```ts
export async function verifyState(token: string): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, getSecret());
  return {
    clientId: payload.clientId as string | undefined,
    platform: payload.platform as string,
    teamMemberId: payload.teamMemberId as string | undefined,
    shopDomain: payload.shopDomain as string | undefined,
  };
}
```

`platform` stays required (every state always has one). `signState`'s body (`new SignJWT({ ...payload })...`) needs no change — spreading an object with an omitted key simply omits that key from the JWT claims, which `jwtVerify` then reads back as `undefined`.

- [ ] **Step 4: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/state-token.test.ts`
Expected: PASS (5 tests — the 4 existing ones plus the new one). The 4 existing tests still pass because they already pass both fields, which the wider type still accepts.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/state-token.ts server/test/lib/state-token.test.ts
git commit -m "$(cat <<'EOF'
feat(server): make clientId and teamMemberId optional on the signed state token

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The install route

**Files:**
- Modify: `server/src/routes/integrations.ts`
- Modify: `server/test/routes/integrations.test.ts`

**Interfaces:**
- Consumes: `normalizeShopDomain` (`server/src/lib/shop-domain.ts`, plan 1), `signState` (Task 1), `connectors["shopify"]` (`server/src/lib/connector-registry.ts`).
- Produces: `GET /api/integrations/shopify/install?shop=<anything normalizeShopDomain accepts>` → redirects to Shopify's OAuth authorize screen (same URL shape `getAuthUrl` already builds) on success, or to `#/manage-clients?connection=error&message=...` on an invalid `shop`.

- [ ] **Step 1: Write the failing tests**

Read `server/test/routes/integrations.test.ts` first to match its exact style (how it stubs `fetch`, reads `res.headers.location`, etc. — it already has this pattern from the existing Shopify callback tests). Add these tests, in a new `describe("GET /api/integrations/shopify/install", ...)` block, at the end of the file:

```ts
describe("GET /api/integrations/shopify/install", () => {
  beforeEach(() => {
    process.env.SHOPIFY_API_KEY = "test-api-key";
    process.env.SHOPIFY_API_SECRET = "test-api-secret";
    process.env.PUBLIC_API_URL = "https://d2c.probild.in";
    process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
    process.env.FRONTEND_URL = "https://d2c.probild.in";
  });

  it("redirects to Shopify's authorize screen for a valid store name, with no auth required", async () => {
    const res = await request(app).get("/api/integrations/shopify/install").query({ shop: "abc-fashion" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
    expect(res.headers.location).toContain("client_id=test-api-key");
    expect(res.headers.location).toContain("state=");
  });

  it("accepts a pasted admin URL the same way the domain field does", async () => {
    const res = await request(app)
      .get("/api/integrations/shopify/install")
      .query({ shop: "https://admin.shopify.com/store/abc-fashion/orders" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://abc-fashion.myshopify.com/admin/oauth/authorize");
  });

  it("redirects to a friendly error for an unrecognizable store, not a raw 400", async () => {
    const res = await request(app).get("/api/integrations/shopify/install").query({ shop: "not a store" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/manage-clients");
    expect(res.headers.location).toContain("connection=error");
  });

  it("signs a state with no clientId or teamMemberId", async () => {
    const res = await request(app).get("/api/integrations/shopify/install").query({ shop: "abc-fashion" });
    const state = new URL(res.headers.location).searchParams.get("state")!;
    const payload = await verifyState(state);
    expect(payload).toEqual({ platform: "shopify", shopDomain: "abc-fashion.myshopify.com", clientId: undefined, teamMemberId: undefined });
  });
});
```

Add `import { verifyState } from "../../src/lib/state-token.js";` to the file's imports if not already present (check first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/integrations.test.ts`
Expected: FAIL (404 — no route mounted).

- [ ] **Step 3: Implement the route**

In `server/src/routes/integrations.ts`, the existing import line `import { verifyState } from "../lib/state-token.js";` becomes:

```ts
import { signState, verifyState } from "../lib/state-token.js";
```

and add this new import alongside the existing ones (`connectors` is already imported):

```ts
import { normalizeShopDomain } from "../lib/shop-domain.js";
```

Then add this route, before `router.get("/:platform/callback", ...)` (order doesn't functionally matter since the paths don't overlap, but keep the shorter, more specific route first for readability):

```ts
router.get("/shopify/install", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const shop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
  if (!shop) {
    const params = new URLSearchParams({
      connection: "error",
      message: "That doesn't look like a Shopify store. Check the link and try again.",
    });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
    return;
  }

  const connector = connectors.shopify;
  const state = await signState({ platform: "shopify", shopDomain: shop });
  res.redirect(connector.getAuthUrl(shop, state));
});
```

`connector.getAuthUrl` is typed on `OAuthConnector` and `connectors.shopify` is always that connector, so no `authType`/existence guard is needed here the way the generic `/:platform/authorize` route needs one for an arbitrary `:platform` param — this route is Shopify-specific by construction.

- [ ] **Step 4: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/integrations.test.ts`
Expected: PASS (all tests in the file, including the existing callback tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/integrations.ts server/test/routes/integrations.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add the public Shopify install-link route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Callback route branches on whether `clientId` is known

**Files:**
- Modify: `server/src/routes/integrations.ts` (the `/:platform/callback` route only)
- Modify: `server/test/routes/integrations.test.ts`

**Interfaces:**
- Consumes: `createPending` (`server/src/lib/pending-connections.ts`, plan 4).
- Produces: when `result.type === "connected"` AND `statePayload.clientId` is present, behavior is byte-identical to before this task. When `result.type === "connected"` AND `statePayload.clientId` is ABSENT, the route stores `{ accessToken, expiresAt, shop: result.externalAccountId }` in `pending_connections` (both `clientId`/`teamMemberId` null) and redirects to `#/connect/claim?pending=<id>`.

- [ ] **Step 1: Write the failing test**

Add this test to `server/test/routes/integrations.test.ts`, inside `describe("GET /api/integrations/:platform/callback", ...)`:

```ts
  it("stores a claim-pending connection when the callback's state has no clientId (the install-link case)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_install_token" }), { status: 200 })),
    );
    const state = await signState({ platform: "shopify", shopDomain: "abc-fashion.myshopify.com" });
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state };
    const hmac = computeTestHmac(query, "test-api-secret");
    const res = await request(app).get("/api/integrations/shopify/callback").query({ ...query, hmac });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/connect/claim");
    expect(res.headers.location).toContain("pending=");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
    const pendingRow = await testPool.query("select client_id, team_member_id from pending_connections");
    expect(pendingRow.rows).toEqual([{ client_id: null, team_member_id: null }]);
  });
```

This reuses the existing `computeTestHmac` helper already defined at the top of the file (used by the file's existing Shopify callback success test) — do not redefine it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/integrations.test.ts`
Expected: FAIL — the route currently always calls `saveConnection` regardless of whether `clientId` is present, so it would throw (`clientId` used as a `string` where `undefined` isn't handled) or produce a wrong redirect/row.

- [ ] **Step 3: Branch the `"connected"` case**

In `server/src/routes/integrations.ts`, read the `/:platform/callback` route's `try` block (it already branches on `result.type` from plan 4 — the `"connected"` branch and the `"pending"` branch). Find the `if (result.type === "connected") { ... }` block:

```ts
    if (result.type === "connected") {
      await saveConnection({
        clientId: statePayload.clientId,
        platform,
        externalAccountId: result.externalAccountId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        connectedBy: statePayload.teamMemberId,
      });
      const params = new URLSearchParams({ connection: "success" });
      res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
      return;
    }
```

Replace it with:

```ts
    if (result.type === "connected") {
      if (statePayload.clientId && statePayload.teamMemberId) {
        await saveConnection({
          clientId: statePayload.clientId,
          platform,
          externalAccountId: result.externalAccountId,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          connectedBy: statePayload.teamMemberId,
        });
        const params = new URLSearchParams({ connection: "success" });
        res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
        return;
      }

      // No client known yet — only the install-link route (Task 2) can produce a state
      // like this. Store the result and let a logged-in user claim it for a client.
      const claimPendingId = await createPending(platform, null, null, {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        shop: result.externalAccountId,
      });
      const claimParams = new URLSearchParams({ pending: claimPendingId });
      res.redirect(`${frontendUrl}/#/connect/claim?${claimParams.toString()}`);
      return;
    }
```

`createPending` is already imported in this file (from plan 4's Task 4). Make ONLY this edit — do not touch the `"pending"` branch below it (Meta's case) or anything else in the file.

- [ ] **Step 4: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/integrations.test.ts`
Expected: PASS — including the existing Shopify/Google/Meta success-case tests (they all pass both `clientId` and `teamMemberId` in their state, so they take the unchanged first branch).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/integrations.ts server/test/routes/integrations.test.ts
git commit -m "$(cat <<'EOF'
feat(server): store a claim-pending connection when the OAuth state has no client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `claim` route

**Files:**
- Modify: `server/src/routes/pending-connections.ts`
- Modify: `server/test/routes/pending-connections.test.ts`

**Interfaces:**
- Consumes: `lockPendingForUpdate` (plan 4's Task 4/final-review fix, already in `server/src/lib/pending-connections.ts`); `saveConnection`; `assertClientAccess`.
- Produces: `POST /api/connections/pending/:id/claim` body `{ clientId }` → `200 { platform, status: "connected", externalAccountId }` (the shop domain) or `404 pending_expired` (missing/expired row) / `400 wrong_pending_type` (row already has a client — a Meta-type row) / `400 invalid_client` (`clientId` missing/not a string) / whatever `assertClientAccess` itself throws for an inaccessible chosen client (NOT rewritten to `pending_expired` — see the Global Constraints note on why this one stays distinct).

- [ ] **Step 1: Write the failing tests**

Read `server/test/routes/pending-connections.test.ts` first (it already has `RIYA`/`SCOPED` team members, an `abc-fashion` client, and a `createPending` import from plan 4). Add a new `describe("POST /api/connections/pending/:id/claim", ...)` block at the end of the file:

```ts
describe("POST /api/connections/pending/:id/claim", () => {
  it("creates the connection for the chosen client and deletes the pending row", async () => {
    const id = await createPending("shopify", null, null, { accessToken: "shop-token", shop: "abc-fashion.myshopify.com" });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/claim`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ clientId: "abc-fashion" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "shopify", status: "connected", externalAccountId: "abc-fashion.myshopify.com" });
    const conn = await testPool.query("select client_id, platform, external_account_id, connected_by from platform_connections");
    expect(conn.rows).toEqual([{ client_id: "abc-fashion", platform: "shopify", external_account_id: "abc-fashion.myshopify.com", connected_by: RIYA }]);
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(0);
  });

  it("404s for an unknown or expired id", async () => {
    const res = await request(app)
      .post("/api/connections/pending/00000000-0000-0000-0000-000000000000/claim")
      .set("Authorization", `Bearer ${token()}`)
      .send({ clientId: "abc-fashion" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("pending_expired");
  });

  it("400s wrong_pending_type for a row that already has a client (Meta's case)", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, { accessToken: "x", candidates: [{ id: "act_1", label: "Main" }] });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/claim`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ clientId: "abc-fashion" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("wrong_pending_type");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("400s invalid_client when clientId is missing", async () => {
    const id = await createPending("shopify", null, null, { accessToken: "x", shop: "abc-fashion.myshopify.com" });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/claim`)
      .set("Authorization", `Bearer ${token()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_client");
  });

  it("rejects (but does not say 'expired') a client the user cannot access", async () => {
    const id = await createPending("shopify", null, null, { accessToken: "x", shop: "abc-fashion.myshopify.com" });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/claim`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: SCOPED, email: "scoped@agency.com" })}`)
      .send({ clientId: "abc-fashion" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).not.toBe("pending_expired");
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(1);
  });

  it("only lets one of two concurrent claims for different clients succeed", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('xyz-beauty', 'XYZ Beauty', 'Beauty', 'bg-rose-500', 'X')`,
    );
    const id = await createPending("shopify", null, null, { accessToken: "shop-token", shop: "abc-fashion.myshopify.com" });
    const [first, second] = await Promise.all([
      request(app).post(`/api/connections/pending/${id}/claim`).set("Authorization", `Bearer ${token()}`).send({ clientId: "abc-fashion" }),
      request(app).post(`/api/connections/pending/${id}/claim`).set("Authorization", `Bearer ${token()}`).send({ clientId: "xyz-beauty" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 404]);
    expect((await testPool.query("select count(*) from platform_connections")).rows[0].count).toBe("1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/pending-connections.test.ts`
Expected: FAIL (404s across the board — no `/claim` route mounted).

- [ ] **Step 3: Implement the route**

In `server/src/routes/pending-connections.ts`, add this route after the existing `POST /:id/select` route (which already imports and uses `pool`, `assertClientAccess`, `HttpError`, `lockPendingForUpdate`, `saveConnection` — no new imports needed):

```ts
router.post("/:id/claim", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pending = await lockPendingForUpdate(client, req.params.id);
    if (!pending) {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }
    if (pending.clientId) {
      // A row created by Meta's picker (plan 4) already has a client — that's the
      // /select action, not this one.
      throw new HttpError(400, "wrong_pending_type", "This connection already knows its client.");
    }

    const chosenClientId = (req.body as { clientId?: unknown }).clientId;
    if (typeof chosenClientId !== "string" || !chosenClientId) {
      throw new HttpError(400, "invalid_client", "Choose which client this store belongs to.");
    }
    // Deliberately NOT rewritten to pending_expired: the person on this page already
    // knows the link is real (it loaded and showed a shop domain) — an access failure
    // here means they picked a client they don't have access to, which is worth saying
    // plainly, unlike plan 4's GET/select where the link's very existence must stay
    // undisclosed to an unauthorized prober.
    await assertClientAccess(pool, req.auth!.userId, chosenClientId);

    await saveConnection({
      clientId: chosenClientId,
      platform: pending.platform,
      externalAccountId: pending.payload.shop ?? "",
      accessToken: pending.payload.accessToken,
      expiresAt: pending.payload.expiresAt,
      connectedBy: req.auth!.userId,
    });
    await client.query("delete from pending_connections where id = $1", [req.params.id]);
    await client.query("commit");

    res.json({ platform: pending.platform, status: "connected", externalAccountId: pending.payload.shop });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});
```

- [ ] **Step 4: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/pending-connections.test.ts test/lib/pending-connections.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pending-connections.ts server/test/routes/pending-connections.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add the atomic claim route for Shopify's install-link flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end route test through the whole install-link flow

**Files:**
- Create: `server/test/routes/shopify-install-link.test.ts`

**Interfaces:**
- Consumes: the real `/install`, `/callback`, and `/claim` routes from Tasks 2-4. No production code changes; proves the whole path (install → OAuth callback → claim → real `platform_connections` row) works together, not just each piece in isolation.

- [ ] **Step 1: Write the test**

Create `server/test/routes/shopify-install-link.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { decryptToken } from "../../src/lib/crypto.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

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
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  process.env.FRONTEND_URL = "https://d2c.probild.in";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the whole Shopify install-link flow", () => {
  it("install -> OAuth callback -> claim results in a real, correctly-encrypted connection", async () => {
    // Step 1: hit the public install route, no auth.
    const installRes = await request(app).get("/api/integrations/shopify/install").query({ shop: "abc-fashion" });
    expect(installRes.status).toBe(302);
    const authorizeUrl = new URL(installRes.headers.location);
    const state = authorizeUrl.searchParams.get("state")!;

    // Step 2: Shopify redirects back to our callback with a code + hmac (simulate what
    // Shopify itself would send, exactly like the existing Shopify callback tests do).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_install_secret" }), { status: 200 })),
    );
    const callbackQuery = { shop: "abc-fashion.myshopify.com", code: "auth-code", state };
    const hmac = computeTestHmac(callbackQuery, "test-api-secret");
    const callbackRes = await request(app).get("/api/integrations/shopify/callback").query({ ...callbackQuery, hmac });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("#/connect/claim");
    const pendingId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("pending")!;
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);

    // Step 3: a logged-in team member claims it for a client.
    const claimRes = await request(app)
      .post(`/api/connections/pending/${pendingId}/claim`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ clientId: "abc-fashion" });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body).toEqual({ platform: "shopify", status: "connected", externalAccountId: "abc-fashion.myshopify.com" });

    const row = (await testPool.query("select access_token, external_account_id from platform_connections")).rows[0];
    expect(decryptToken(row.access_token)).toBe("shpat_install_secret");
    expect(row.external_account_id).toBe("abc-fashion.myshopify.com");
    expect(row.access_token).not.toContain("shpat_install_secret");
    expect((await testPool.query("select 1 from pending_connections where id = $1", [pendingId])).rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/shopify-install-link.test.ts`
Expected: PASS (1 test). If it fails, that reveals a real integration bug in Tasks 1-4: fix the production code responsible (never the test) and document the bug and fix in your report.

- [ ] **Step 3: Commit**

```bash
git add server/test/routes/shopify-install-link.test.ts
git commit -m "$(cat <<'EOF'
test(server): cover the whole install-link flow end to end

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — the claim page

**Files:**
- Create: `src/pages/connect-claim.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError` (`src/lib/api.ts`); `useApp()` (`src/store/app-context.tsx`, for the `clients` list); backend `GET /api/connections/pending/:id` and `POST /api/connections/pending/:id/claim` (Task 4).
- Produces: route `/connect/claim` rendering `ConnectClaim`, reading `?pending=<id>` from the URL.

Before starting, run `npm run lint 2>&1 | grep -c "warning"` and record the baseline.

- [ ] **Step 1: Create the page**

Create `src/pages/connect-claim.tsx`:

```tsx
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api";
import { useApp } from "@/store/app-context";

interface PendingInfo {
  platform: string;
  clientId: string | null;
  shop?: string;
}

export default function ConnectClaim() {
  const [params] = useSearchParams();
  const pendingId = params.get("pending");
  const navigate = useNavigate();
  const { clients } = useApp();

  const [info, setInfo] = React.useState<PendingInfo | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [claimError, setClaimError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!pendingId) {
      setLoadError("This link expired, please connect again.");
      return;
    }
    let cancelled = false;
    apiFetch(`/api/connections/pending/${pendingId}`)
      .then((res) => res.json())
      .then((body: PendingInfo) => {
        if (!cancelled) setInfo(body);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "This link expired, please connect again.");
      });
    return () => {
      cancelled = true;
    };
  }, [pendingId]);

  const confirm = async () => {
    if (!pendingId || !selectedClientId) return;
    setBusy(true);
    setClaimError(null);
    try {
      await apiFetch(`/api/connections/pending/${pendingId}/claim`, {
        method: "POST",
        body: JSON.stringify({ clientId: selectedClientId }),
      });
      navigate("/manage-clients?connection=success");
    } catch (err) {
      setClaimError(err instanceof ApiError ? err.message : "Failed to connect. Please try again.");
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-4">
        <Card className="max-w-sm">
          <CardContent className="p-5 text-center">
            <p className="text-[13px] text-negative">{loadError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="size-6 animate-spin rounded-full border-2 border-border border-t-brand" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Which client is this?</CardTitle>
          <CardDescription>
            {info.shop ?? "This Shopify store"} just connected. Pick the client it belongs to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 px-5 pb-5">
          {clients.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle p-2.5 text-[12.5px] has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
            >
              <input
                type="radio"
                name="client"
                value={c.id}
                checked={selectedClientId === c.id}
                onChange={() => setSelectedClientId(c.id)}
              />
              {c.name}
            </label>
          ))}
          {claimError && (
            <p role="alert" className="text-[11px] text-negative">
              {claimError}
            </p>
          )}
          <Button className="w-full" disabled={!selectedClientId || busy} onClick={confirm}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `src/App.tsx`:
1. Add `const ConnectClaim = lazy(() => import("@/pages/connect-claim"));` with the other lazy imports.
2. Add `<Route path="/connect/claim" element={<ConnectClaim />} />` directly next to the existing `<Route path="/connect/pick-accounts" element={<ConnectPickAccounts />} />` line — same reasoning as that route: inside `RequireAuth`, outside `AppShell`.

- [ ] **Step 3: Verify**

Run: `npm run build`
Expected: succeeds.

Run: `npm run lint 2>&1 | grep -c "warning"`
Expected: count no higher than the baseline from before Step 1, plus AT MOST one new warning if this page's data-fetch effect triggers the same `set-state-in-effect` warning `connect-pick-accounts.tsx` did (plan 4 — accepted there for the identical reason: it's the same rule already tolerated elsewhere in the codebase). If exactly that one warning appears, it is acceptable; any OTHER new warning is not.

- [ ] **Step 4: Manual verification (honest reporting)**

If a Supabase session, backend, and a real Shopify dev store are available: hit `/api/integrations/shopify/install?shop=<real-dev-store>` directly in a browser (not logged in), approve on Shopify's screen, confirm landing on the claim page after logging in if needed, confirm every client appears as an option, selecting one and clicking Connect lands back on Manage Clients with the store shown as Connected. If not available, state explicitly which of these were NOT verified — do not claim them.

- [ ] **Step 5: Commit**

```bash
git add src/pages/connect-claim.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat: add the Shopify install-link claim page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification, sharing the install link, real-account checklist, graph refresh

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the whole server suite and type-check**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: type-check clean; every test file passes.

- [ ] **Step 2: Frontend checks**

Run: `npm run build && npm run lint 2>&1 | grep -c "warning"`
Expected: build succeeds; count not above the pre-plan baseline plus at most the one accepted `set-state-in-effect` warning from Task 6.

- [ ] **Step 3: Secrets check**

Run: `git grep -n "shpat_install_secret\|shop-token" -- server/src src`
Expected: no matches outside test files.

- [ ] **Step 4: Refresh the knowledge graph**

Run: `graphify update .`
Expected: completes without error. Then `git status --short graphify-out | head`. If tracked files changed, commit only `graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json`:

```bash
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json
git commit -m "$(cat <<'EOF'
chore: refresh graphify graph after the Shopify install-link flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Write the real-account checklist into your report**

This plan is lower-risk than plans 3/4 — Shopify's OAuth itself is unchanged, already-shipped, already-live code (plans 1-2); this plan only adds a new entry point into it. Still, write this checklist into your final report verbatim, and be explicit that it was NOT performed:

1. Generate a real install link (`https://<the deployed API host>/api/integrations/shopify/install?shop=<a real dev store>`) and open it in a private/incognito browser window with no dashboard session — confirm it goes straight to Shopify's own approval screen with no intermediate page.
2. Approve on Shopify's screen; confirm the redirect lands on the claim page and, if not already logged into the dashboard, that `RequireAuth` sends it to `/login` first and returns to the claim page after logging in (React Router's default redirect-back behavior — confirm this actually works end to end, since `RequireAuth`'s `<Navigate to="/login" replace />` does not itself carry a return-to param; if it doesn't return automatically, note this as a follow-up).
3. Confirm every client the logged-in user can access appears in the picker, selecting one connects it, and it shows up correctly (store domain, "Connected") on the Manage Clients page.
4. Try the link again after it's been claimed (or after 30 minutes) — confirm it shows "This link expired, please connect again." and does not resurrect the old pending row.
5. Confirm the existing domain-field connect flow (plan 1, from inside Manage Clients) still works completely unchanged — this plan's whole design rests on that flow being untouched, and this is the one thing worth actually re-confirming live.

- [ ] **Step 6: Report**

Summarize for the user: what shipped, exact test/build results, which manual states in Task 6 were verified vs not, and the five-item real-account checklist from Step 5. Note that this completes all 5 plans of the spec's original rollout.
