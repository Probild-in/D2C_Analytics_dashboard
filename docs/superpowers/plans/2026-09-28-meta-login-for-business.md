# Meta Login for Business + Ad-Account Picker (Plan 4 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client's Meta connection goes through Facebook Login for Business (`config_id`) instead of a bare OAuth dialog, and when the login grants more than one ad account, the user picks which one to connect instead of silently getting the first one.

**Architecture:** `metaConnector.getAuthUrl` adds a `config_id` parameter (an operator-configured Configuration Set, not app code). `handleCallback` across all three OAuth connectors changes its return shape to a discriminated union (`"connected"` vs `"pending"`), so Meta can signal "the user needs to choose" without inventing a parallel code path. A new `pending_connections` table and router hold that in-flight choice (encrypted, 30-minute expiry) until the user picks an account on a new frontend page. This table and router are also plan 5's foundation — plan 5 adds a `claim` action to the same router; this plan does not.

**Tech Stack:** Node/Express/TypeScript, `pg`, `jose` (JWT), Vitest + Supertest (server); React 19 + Vite + React Router (frontend).

**Spec:** `docs/superpowers/specs/2026-09-27-simple-integrations-design.md` (plan 4 of its 5-plan rollout; amended 2026-09-28 for this plan — read its "Meta (plan 4)" and `pending_connections` sections, which carry the full sourcing rationale this plan only summarizes)

## Global Constraints

- Server tests need a real Postgres: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run <files>`. Server type-check: `cd server && npx tsc --noEmit` (baseline clean, keep it clean).
- Frontend verification is `npm run build` and `npm run lint`; **no frontend test runner exists and this plan does not add one.** Before Task 6, record the lint baseline (`npm run lint 2>&1 | grep -c "warning"` — use `grep -c`, not `tail -N`, per a mistake caught in plan 3); afterward the count must not exceed it and no new warning may come from a file this plan touches.
- Secrets: `pending_connections.payload` is encrypted with `encryptToken`/`decryptToken` (`server/src/lib/crypto.ts`), exactly like `platform_connections`. It is never returned by any GET endpoint — only the decrypted candidate list (id/label) or shop domain needed to render a choice.
- Errors use `HttpError(status, code, message)`; body `{ error: { code, message } }`.
- **What is and isn't sourced:** the Configuration-creation flow, `config_id` as a valid manual-flow dialog parameter, and the code→token exchange endpoint are confirmed (a direct fetch of Meta's own "Facebook Login for Business" doc page — Context7 had nothing at endpoint level for this topic). Whether `scope=ads_read` should be dropped once `config_id` is present is NOT confirmed; this plan keeps `scope` in place defensively and flags it for the real-account checklist. Everything else about the Meta Marketing API used here (ad-accounts listing, campaigns, insights) is unchanged, already-shipped code from before this plan.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` copied EXACTLY (never substitute your own model name).
- `META_LOGIN_CONFIG_ID` is a new required env var for the Meta connector (alongside the existing `META_APP_ID`/`META_APP_SECRET`); tests set it via `process.env` in `beforeEach`, same pattern as the existing ones.

---

### Task 1: Migration 010 — `pending_connections` table

**Files:**
- Create: `server/migrations/010_pending_connections.sql`
- Create: `server/test/migration-010.test.ts`

**Interfaces:**
- Produces: table `pending_connections (id uuid pk default gen_random_uuid(), platform text not null, client_id text references clients(id) on delete cascade, team_member_id uuid references team_members(id), payload text not null, expires_at timestamptz not null, created_at timestamptz not null default now())`. `client_id` and `team_member_id` are BOTH nullable — Meta's picker knows both up front (not null); plan 5's Shopify claim knows neither at creation (null until claimed, out of scope for this plan). Tasks 3-5 rely on these exact column names and nullability.

- [ ] **Step 1: Write the failing test**

Create `server/test/migration-010.test.ts`:

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
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
});

describe("migration 010 (pending_connections)", () => {
  it("stores a pending connection with a known client and team member", async () => {
    await testPool.query(
      `insert into pending_connections (platform, client_id, team_member_id, payload, expires_at) values
       ('meta', 'abc-fashion', '11111111-1111-1111-1111-111111111111', 'encrypted-blob', now() + interval '30 minutes')`,
    );
    const res = await testPool.query("select platform, client_id, team_member_id, payload from pending_connections");
    expect(res.rows).toEqual([
      {
        platform: "meta",
        client_id: "abc-fashion",
        team_member_id: "11111111-1111-1111-1111-111111111111",
        payload: "encrypted-blob",
      },
    ]);
  });

  it("allows client_id and team_member_id to both be null", async () => {
    await testPool.query(
      `insert into pending_connections (platform, payload, expires_at) values
       ('shopify', 'encrypted-blob', now() + interval '30 minutes')`,
    );
    const res = await testPool.query("select client_id, team_member_id from pending_connections");
    expect(res.rows).toEqual([{ client_id: null, team_member_id: null }]);
  });

  it("deletes pending rows when the client is deleted", async () => {
    await testPool.query(
      `insert into pending_connections (platform, client_id, payload, expires_at) values
       ('meta', 'abc-fashion', 'encrypted-blob', now() + interval '30 minutes')`,
    );
    await testPool.query("delete from clients where id = 'abc-fashion'");
    expect((await testPool.query("select 1 from pending_connections")).rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-010.test.ts`
Expected: FAIL (`relation "pending_connections" does not exist`).

- [ ] **Step 3: Write the migration**

Create `server/migrations/010_pending_connections.sql`:

```sql
-- Holds an in-flight OAuth result that needs a user choice before it becomes a real
-- platform_connections row: Meta's ad-account picker (plan 4) and Shopify's install-link
-- client claim (plan 5). client_id/team_member_id are both known up front for Meta's
-- picker; both are null until claimed for Shopify's install link.
create table pending_connections (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  client_id text references clients(id) on delete cascade,
  team_member_id uuid references team_members(id),
  -- Encrypted JSON (same encryptToken scheme as platform_connections' own token columns).
  -- Never returned by any GET endpoint — only its decrypted, non-secret fields are.
  payload text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/migration-010.test.ts test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/010_pending_connections.sql server/test/migration-010.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add pending_connections table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `OAuthConnector.handleCallback` returns a discriminated union

**Files:**
- Modify: `server/src/integrations/types.ts`
- Modify: `server/src/integrations/shopify.ts` (the `handleCallback` return statement only)
- Modify: `server/src/integrations/google.ts` (the `handleCallback` return statement only)
- Modify: `server/test/integrations/shopify.test.ts` (update existing assertions)
- Modify: `server/test/integrations/google.test.ts` (update existing assertions)

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type OAuthCallbackResult =
    | { type: "connected"; externalAccountId: string; accessToken: string; refreshToken?: string; expiresAt?: Date }
    | { type: "pending"; accessToken: string; expiresAt?: Date; candidates: { id: string; label: string }[] };
  ```
  `OAuthConnector.handleCallback` now returns `Promise<OAuthCallbackResult>` instead of the old flat object type. Task 3 (Meta) and Task 4 (the callback route) consume this.

- [ ] **Step 1: Write the failing tests**

In `server/test/integrations/shopify.test.ts`, find the existing assertion in `"exchanges the code for an access token"` (inside `describe("shopifyConnector.handleCallback", ...)`):

```ts
    expect(result).toEqual({ externalAccountId: "test-shop.myshopify.com", accessToken: "shpat_real_token" });
```

Change it to:

```ts
    expect(result).toEqual({ type: "connected", externalAccountId: "test-shop.myshopify.com", accessToken: "shpat_real_token" });
```

In `server/test/integrations/google.test.ts`, find the analogous existing assertion inside `describe("googleConnector.handleCallback", ...)` for its success case (read the file first to find the exact current `expect(result).toEqual({...})` or `toMatchObject({...})` line — it currently checks `externalAccountId`/`accessToken`/`refreshToken` without a `type` field). Add `type: "connected",` as the first key in that same object.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shopify.test.ts test/integrations/google.test.ts`
Expected: FAIL (both updated assertions — the connectors don't add `type` yet).

- [ ] **Step 3: Add the union type**

In `server/src/integrations/types.ts`, add this export near the top of the file (after the existing `CredentialsRejectedError` class, before the `BaseConnector` interface):

```ts
// handleCallback's result: either the OAuth login resolved to exactly one account and is
// ready to save, or it granted several and the user needs to pick one (Meta's ad-account
// picker) or the account owning it isn't known yet (Shopify's install-link claim, plan 5).
export type OAuthCallbackResult =
  | {
      type: "connected";
      externalAccountId: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: Date;
    }
  | {
      type: "pending";
      accessToken: string;
      expiresAt?: Date;
      candidates: { id: string; label: string }[];
    };
```

Then change the `OAuthConnector` interface's `handleCallback` signature from:

```ts
  handleCallback(query: Record<string, string>, context: { clientId: string }): Promise<{
    externalAccountId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;
```

to:

```ts
  handleCallback(query: Record<string, string>, context: { clientId: string }): Promise<OAuthCallbackResult>;
```

- [ ] **Step 4: Wrap Shopify's and Google's returns**

In `server/src/integrations/shopify.ts`, find the `handleCallback` method's final line:

```ts
    return { externalAccountId: shop, accessToken: body.access_token };
```

Change it to:

```ts
    return { type: "connected", externalAccountId: shop, accessToken: body.access_token };
```

In `server/src/integrations/google.ts`, read the `handleCallback` method's final `return { ... }` statement (find it — it returns `externalAccountId`, `accessToken`, `refreshToken`) and add `type: "connected",` as its first key, changing nothing else about the object.

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output. (This will also catch `server/src/routes/integrations.ts` if it destructures the old flat shape — do NOT fix that file in this task; it's Task 4's job. If `tsc` fails only on that file, that's expected and fine to leave for Task 4; if it fails anywhere else, investigate.)

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/shopify.test.ts test/integrations/google.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/types.ts server/src/integrations/shopify.ts server/src/integrations/google.ts server/test/integrations/shopify.test.ts server/test/integrations/google.test.ts
git commit -m "$(cat <<'EOF'
feat(server): give OAuthConnector.handleCallback a connected/pending result type

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Meta connector — `config_id` and the ad-account picker branch

**Files:**
- Modify: `server/src/integrations/meta.ts` (`getAuthUrl` and `handleCallback` only)
- Modify: `server/test/integrations/meta.test.ts`

**Interfaces:**
- Consumes: `OAuthCallbackResult` (Task 2).
- Produces: `metaConnector.getAuthUrl` includes `config_id`/`response_type=code`; `metaConnector.handleCallback` returns `{ type: "connected", ... }` for exactly one ad account (unchanged behavior otherwise) or `{ type: "pending", accessToken, expiresAt, candidates }` for more than one, where `candidates` is every returned ad account mapped to `{ id, label: name }`.

- [ ] **Step 1: Write the failing tests**

In `server/test/integrations/meta.test.ts`:

1. In the `beforeEach` at the top of the file, add `process.env.META_LOGIN_CONFIG_ID = "test-config-id";` alongside the existing `META_APP_ID`/`META_APP_SECRET` lines.
2. In `describe("metaConnector.getAuthUrl", ...)`, replace the existing test with:

```ts
  it("builds a Facebook Login for Business dialog URL", () => {
    const url = metaConnector.getAuthUrl("abc-fashion", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.facebook.com");
    expect(parsed.pathname).toBe("/v21.0/dialog/oauth");
    expect(parsed.searchParams.get("client_id")).toBe("test-app-id");
    expect(parsed.searchParams.get("config_id")).toBe("test-config-id");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("ads_read");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/meta/callback");
  });
```

3. In `describe("metaConnector.handleCallback", ...)`, find the existing test `"exchanges the code for an access token and resolves the ad account id"` and change its final assertion from whatever flat-shape `expect(result).toEqual({...})` it currently has to the same fields prefixed with `type: "connected",` (read the current test first to get the exact other fields — likely `externalAccountId`, `accessToken`, and possibly `expiresAt`). Then add these two new tests directly after it:

```ts
  it("returns type 'pending' with every candidate account when more than one is granted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "meta-token", expires_in: 5184000 }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: [
              { id: "act_111", name: "ABC Fashion — Main" },
              { id: "act_222", name: "ABC Fashion — Retargeting" },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const result = await metaConnector.handleCallback({ code: "auth-code" }, { clientId: "abc-fashion" });
    expect(result.type).toBe("pending");
    if (result.type !== "pending") throw new Error("expected pending");
    expect(result.accessToken).toBe("meta-token");
    expect(result.candidates).toEqual([
      { id: "act_111", label: "ABC Fashion — Main" },
      { id: "act_222", label: "ABC Fashion — Retargeting" },
    ]);
  });

  it("still checks the account limit before a multi-account callback, same as the single-account path", async () => {
    await testPool.query("update subscriptions set extra_meta_accounts = -1 where client_id = 'abc-fashion'");
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id) values
       ('abc-fashion', 'meta', 'connected', 'act_existing')`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "meta-token" }), { status: 200 });
        return new Response(JSON.stringify({ data: [{ id: "act_111", name: "A" }, { id: "act_222", name: "B" }] }), { status: 200 });
      }),
    );
    await expect(metaConnector.handleCallback({ code: "auth-code" }, { clientId: "abc-fashion" })).rejects.toThrow(/limit/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/meta.test.ts`
Expected: FAIL (`config_id`/`response_type` missing from the URL; `result.type` is undefined; the pending branch doesn't exist yet).

- [ ] **Step 3: Add `config_id` to `getAuthUrl`**

In `server/src/integrations/meta.ts`, in `getAuthUrl`, after the existing `url.searchParams.set("client_id", appId);` line, add:

```ts
    url.searchParams.set("config_id", getLoginConfigId());
    url.searchParams.set("response_type", "code");
```

Add a new helper function directly above `getCredentials`:

```ts
function getLoginConfigId(): string {
  const configId = process.env.META_LOGIN_CONFIG_ID;
  if (!configId) {
    throw new Error("META_LOGIN_CONFIG_ID environment variable must be set");
  }
  return configId;
}
```

- [ ] **Step 4: Branch `handleCallback` on the number of ad accounts**

In `server/src/integrations/meta.ts`, find the end of `handleCallback` — the block that checks `adAccountsBody.data.length === 0` and then returns. Replace from that check through the end of the method:

```ts
    if (adAccountsBody.data.length === 0) {
      throw new Error("No Meta ad account is accessible with this login — the user must have at least one ad account");
    }

    return {
      externalAccountId: adAccountsBody.data[0].id,
      accessToken: tokenBody.access_token,
      expiresAt: tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000) : undefined,
    };
  },
```

with:

```ts
    if (adAccountsBody.data.length === 0) {
      throw new Error("No Meta ad account is accessible with this login — the user must have at least one ad account");
    }

    const expiresAt = tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000) : undefined;

    if (adAccountsBody.data.length === 1) {
      return {
        type: "connected",
        externalAccountId: adAccountsBody.data[0].id,
        accessToken: tokenBody.access_token,
        expiresAt,
      };
    }

    // More than one ad account was granted — the user picks which one on the frontend's
    // pick-accounts page (server/src/routes/pending-connections.js, Task 5). The account
    // limit is already checked above, before we get here, same as the single-account path.
    return {
      type: "pending",
      accessToken: tokenBody.access_token,
      expiresAt,
      candidates: adAccountsBody.data.map((account) => ({ id: account.id, label: account.name })),
    };
  },
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output (or only the expected pre-existing failure in `integrations.ts`, same caveat as Task 2 Step 5 — do not fix that file here).

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/integrations/meta.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/meta.ts server/test/integrations/meta.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add config_id to Meta's login dialog and a multi-account pending branch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Callback route branches on `type`; `pending-connections` storage helper

**Files:**
- Create: `server/src/lib/pending-connections.ts`
- Modify: `server/src/routes/integrations.ts`
- Create: `server/test/lib/pending-connections.test.ts`
- Modify: `server/test/routes/integrations.test.ts`

**Interfaces:**
- Produces (`pending-connections.ts`):
  ```ts
  export interface PendingPayload { accessToken: string; expiresAt?: Date; candidates?: { id: string; label: string }[]; shop?: string; }
  export async function createPending(platform: string, clientId: string | null, teamMemberId: string | null, payload: PendingPayload): Promise<string>; // returns the new row's id
  export async function readPending(id: string): Promise<{ platform: string; clientId: string | null; teamMemberId: string | null; payload: PendingPayload } | null>; // null if missing or expired
  export async function deletePending(id: string): Promise<void>;
  ```
  Task 5 (the pending-connections API route) consumes all three.

- [ ] **Step 1: Write the failing tests**

Create `server/test/lib/pending-connections.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { createPending, readPending, deletePending } from "../../src/lib/pending-connections.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
});

describe("createPending / readPending", () => {
  it("round-trips a payload with client and team member known (Meta's case)", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", {
      accessToken: "secret-token",
      candidates: [{ id: "act_1", label: "Main" }],
    });
    const row = await readPending(id);
    expect(row).toEqual({
      platform: "meta",
      clientId: "abc-fashion",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
      payload: { accessToken: "secret-token", candidates: [{ id: "act_1", label: "Main" }] },
    });
  });

  it("round-trips a payload with client and team member both null (Shopify's install-link case)", async () => {
    const id = await createPending("shopify", null, null, { accessToken: "secret-token", shop: "abc.myshopify.com" });
    const row = await readPending(id);
    expect(row).toEqual({
      platform: "shopify",
      clientId: null,
      teamMemberId: null,
      payload: { accessToken: "secret-token", shop: "abc.myshopify.com" },
    });
  });

  it("never stores the access token in plaintext", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", {
      accessToken: "very-secret-token-value",
    });
    const raw = await testPool.query("select payload from pending_connections where id = $1", [id]);
    expect(raw.rows[0].payload).not.toContain("very-secret-token-value");
  });

  it("returns null for an unknown id", async () => {
    expect(await readPending("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null for an expired row without deleting it (deletion is the caller's job)", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", { accessToken: "x" });
    await testPool.query("update pending_connections set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect(await readPending(id)).toBeNull();
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(1);
  });
});

describe("deletePending", () => {
  it("removes the row", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", { accessToken: "x" });
    await deletePending(id);
    expect(await readPending(id)).toBeNull();
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(0);
  });

  it("is a no-op for an id that doesn't exist", async () => {
    await expect(deletePending("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/pending-connections.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the storage helper**

Create `server/src/lib/pending-connections.ts`:

```ts
import pool from "../db.js";
import { encryptToken, decryptToken } from "./crypto.js";

const EXPIRES_IN_MINUTES = 30;

export interface PendingPayload {
  accessToken: string;
  expiresAt?: Date;
  candidates?: { id: string; label: string }[];
  // Shopify's install-link claim (plan 5) only.
  shop?: string;
}

export interface PendingRow {
  platform: string;
  clientId: string | null;
  teamMemberId: string | null;
  payload: PendingPayload;
}

// Both nullable: Meta's ad-account picker knows both up front; Shopify's install-link
// claim (plan 5) knows neither until the user picks a client.
export async function createPending(
  platform: string,
  clientId: string | null,
  teamMemberId: string | null,
  payload: PendingPayload,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into pending_connections (platform, client_id, team_member_id, payload, expires_at)
     values ($1, $2, $3, $4, now() + interval '${EXPIRES_IN_MINUTES} minutes')
     returning id`,
    [platform, clientId, teamMemberId, encryptToken(JSON.stringify(payload))],
  );
  return result.rows[0].id;
}

// Returns null for a missing OR expired row — deliberately not distinguished (see the
// spec's error-handling section: a stale link should never confirm it was once valid).
// Does not delete an expired row; the caller (the route) owns deletion after a successful
// select/claim, and a separate sweep can clean up abandoned expired rows.
export async function readPending(id: string): Promise<PendingRow | null> {
  const result = await pool.query(
    `select platform, client_id, team_member_id, payload
     from pending_connections
     where id = $1 and expires_at > now()`,
    [id],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    platform: row.platform,
    clientId: row.client_id,
    teamMemberId: row.team_member_id,
    payload: JSON.parse(decryptToken(row.payload)) as PendingPayload,
  };
}

export async function deletePending(id: string): Promise<void> {
  await pool.query("delete from pending_connections where id = $1", [id]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/pending-connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Branch the callback route on `type`**

Read `server/src/routes/integrations.ts` first (it's short). Replace the `try` block's contents — currently:

```ts
  try {
    const { externalAccountId, accessToken, refreshToken, expiresAt } = await connector.handleCallback(query, {
      clientId: statePayload.clientId,
    });
    await saveConnection({
      clientId: statePayload.clientId,
      platform,
      externalAccountId,
      accessToken,
      refreshToken,
      expiresAt,
      connectedBy: statePayload.teamMemberId,
    });
    const params = new URLSearchParams({ connection: "success" });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
  } catch {
    redirectError("Failed to connect — please try again");
  }
```

with:

```ts
  try {
    const result = await connector.handleCallback(query, { clientId: statePayload.clientId });

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

    // type === "pending": the client and team member are already known from the state
    // token (this is Meta's multi-account case, not Shopify's install-link claim, which
    // has neither — plan 5 creates its own pending rows directly, not through this route).
    const pendingId = await createPending(platform, statePayload.clientId, statePayload.teamMemberId, {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      candidates: result.candidates,
    });
    const params = new URLSearchParams({ pending: pendingId });
    res.redirect(`${frontendUrl}/#/connect/pick-accounts?${params.toString()}`);
  } catch {
    redirectError("Failed to connect — please try again");
  }
```

Add the import `import { createPending } from "../lib/pending-connections.js";` alongside the existing imports at the top of the file.

- [ ] **Step 6: Add a route test for the pending redirect**

In `server/test/routes/integrations.test.ts`, read the file first to match its existing HMAC/fetch-stub helper style (used for the Shopify success test). Add a new test inside `describe("GET /api/integrations/:platform/callback", ...)` — since this exercises Meta, not Shopify, it won't need the HMAC helper, just a `signState` for platform `"meta"` and a stubbed multi-account fetch response:

```ts
  it("redirects to the pick-accounts page when Meta's callback returns type 'pending'", async () => {
    process.env.META_APP_ID = "test-app-id";
    process.env.META_APP_SECRET = "test-app-secret";
    process.env.META_LOGIN_CONFIG_ID = "test-config-id";
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) return new Response(JSON.stringify({ access_token: "meta-token" }), { status: 200 });
        return new Response(
          JSON.stringify({ data: [{ id: "act_111", name: "A" }, { id: "act_222", name: "B" }] }),
          { status: 200 },
        );
      }),
    );
    const state = await signState({
      clientId: "abc-fashion",
      platform: "meta",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
    });
    const res = await request(app).get("/api/integrations/meta/callback").query({ code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/connect/pick-accounts");
    expect(res.headers.location).toContain("pending=");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
    expect((await testPool.query("select client_id, team_member_id from pending_connections")).rows).toEqual([
      { client_id: "abc-fashion", team_member_id: "11111111-1111-1111-1111-111111111111" },
    ]);
  });
```

Add `import { vi } from "vitest";` and `import { testPool } from "../helpers/test-db.js";` if not already imported in that file (check first).

- [ ] **Step 7: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/pending-connections.test.ts test/routes/integrations.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/lib/pending-connections.ts server/src/routes/integrations.ts server/test/lib/pending-connections.test.ts server/test/routes/integrations.test.ts
git commit -m "$(cat <<'EOF'
feat(server): store multi-account Meta callbacks as a pending connection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `pending-connections` API route — `GET` and `select`

**Files:**
- Create: `server/src/routes/pending-connections.ts`
- Modify: `server/src/index.ts` (mount the router)
- Create: `server/test/routes/pending-connections.test.ts`

**Interfaces:**
- Consumes: `readPending`, `deletePending` (Task 4); `assertClientAccess` (`server/src/lib/access.ts`); `saveConnection`; `assertUnderMetaAccountLimit` — Step 3 below exports this existing, currently-private function from `meta.ts` so this route can reuse it instead of duplicating its SQL (limit enforcement belongs at the point of creating a `platform_connections` row; `handleCallback` already checked it once before the pending row was created, so this is a second, cheap check for the case where another connection landed in between).
- Produces: `GET /api/connections/pending/:id` → `200 { platform, clientId, candidates }` (Meta shape; `candidates` omitted for a non-Meta pending row) or `404 pending_expired`. `POST /api/connections/pending/:id/select` body `{ externalAccountId }` → `200 { platform, status: "connected", externalAccountId }` or `404 pending_expired` / `400 invalid_candidate` / `403` (account limit, reusing the existing message format) — never `500` on a normal limit rejection.

- [ ] **Step 1: Write the failing tests**

Create `server/test/routes/pending-connections.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { createPending } from "../../src/lib/pending-connections.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const SCOPED = "22222222-2222-2222-2222-222222222222";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
     ('${SCOPED}', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into plans (id, name, monthly_fee_inr, included_meta_accounts, included_google_accounts) values
     ('starter', 'Starter', 5000, 1, 1)`,
  );
  await testPool.query(
    `insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'starter', 'active')`,
  );
});

describe("GET /api/connections/pending/:id", () => {
  it("returns the platform and candidates without the access token", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "very-secret",
      candidates: [{ id: "act_1", label: "Main" }, { id: "act_2", label: "Retargeting" }],
    });
    const res = await request(app).get(`/api/connections/pending/${id}`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      platform: "meta",
      clientId: "abc-fashion",
      candidates: [{ id: "act_1", label: "Main" }, { id: "act_2", label: "Retargeting" }],
    });
    expect(JSON.stringify(res.body)).not.toContain("very-secret");
  });

  it("404s for an unknown or expired id", async () => {
    const res = await request(app)
      .get("/api/connections/pending/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("pending_expired");
  });

  it("404s for a user who cannot access the pending row's client", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, { accessToken: "x", candidates: [] });
    const res = await request(app)
      .get(`/api/connections/pending/${id}`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: SCOPED, email: "scoped@agency.com" })}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/connections/pending/:id/select", () => {
  it("creates the connection with the chosen account and deletes the pending row", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "chosen-token",
      candidates: [{ id: "act_1", label: "Main" }, { id: "act_2", label: "Retargeting" }],
    });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_2" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "meta", status: "connected", externalAccountId: "act_2" });
    const conn = await testPool.query("select platform, external_account_id from platform_connections");
    expect(conn.rows).toEqual([{ platform: "meta", external_account_id: "act_2" }]);
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(0);
  });

  it("400s for an externalAccountId that wasn't one of the candidates", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "x",
      candidates: [{ id: "act_1", label: "Main" }],
    });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_999" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_candidate");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("404s for an unknown or expired id", async () => {
    const res = await request(app)
      .post("/api/connections/pending/00000000-0000-0000-0000-000000000000/select")
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_1" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("pending_expired");
  });

  it("enforces the Meta account limit at select time", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id) values
       ('abc-fashion', 'meta', 'connected', 'act_existing')`,
    );
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "x",
      candidates: [{ id: "act_1", label: "Main" }],
    });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_1" });
    expect(res.status).toBe(403);
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(1);
  });

  it("404s for a user who cannot access the pending row's client", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, { accessToken: "x", candidates: [{ id: "act_1", label: "Main" }] });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: SCOPED, email: "scoped@agency.com" })}`)
      .send({ externalAccountId: "act_1" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/pending-connections.test.ts`
Expected: FAIL (404s across the board — no route mounted).

- [ ] **Step 3: Export Meta's account-limit check, then implement the route**

In `server/src/integrations/meta.ts`, find `async function assertUnderMetaAccountLimit(clientId: string): Promise<void> {` and change `async function` to `export async function` — that is the ONLY change to this file in this task. Everything inside the function stays exactly as it is.

Create `server/src/routes/pending-connections.ts`:

```ts
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { readPending, deletePending } from "../lib/pending-connections.js";
import { saveConnection } from "../lib/connection-store.js";
import { assertUnderMetaAccountLimit } from "../integrations/meta.js";

const router = Router();

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const pending = await readPending(req.params.id);
    if (!pending) {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }
    if (pending.clientId) {
      await assertClientAccess(pool, req.auth!.userId, pending.clientId);
    }
    res.json({
      platform: pending.platform,
      clientId: pending.clientId,
      // Shopify's install-link claim (plan 5) has no candidates; omit rather than send [].
      ...(pending.payload.candidates ? { candidates: pending.payload.candidates } : {}),
      ...(pending.payload.shop ? { shop: pending.payload.shop } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/select", requireAuth, async (req, res, next) => {
  try {
    const pending = await readPending(req.params.id);
    if (!pending) {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }
    if (!pending.clientId) {
      // A Shopify-style claim-only row (no client yet) has nothing to "select" — that's
      // the /claim action plan 5 adds, not this one.
      throw new HttpError(400, "wrong_pending_type", "This connection has no account choice to make.");
    }
    await assertClientAccess(pool, req.auth!.userId, pending.clientId);

    const externalAccountId = (req.body as { externalAccountId?: unknown }).externalAccountId;
    const candidate = pending.payload.candidates?.find((c) => c.id === externalAccountId);
    if (typeof externalAccountId !== "string" || !candidate) {
      throw new HttpError(400, "invalid_candidate", "That account wasn't one of the ones offered.");
    }

    // Re-check the limit here: handleCallback already checked it once before this pending
    // row was created, but another connection could have landed in the meantime.
    if (pending.platform === "meta") {
      try {
        await assertUnderMetaAccountLimit(pending.clientId);
      } catch (err) {
        throw new HttpError(403, "account_limit", err instanceof Error ? err.message : "Meta account limit reached");
      }
    }

    await saveConnection({
      clientId: pending.clientId,
      platform: pending.platform,
      externalAccountId: candidate.id,
      accessToken: pending.payload.accessToken,
      expiresAt: pending.payload.expiresAt,
      connectedBy: pending.teamMemberId ?? req.auth!.userId,
    });
    await deletePending(req.params.id);

    res.json({ platform: pending.platform, status: "connected", externalAccountId: candidate.id });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, add `import pendingConnectionsRouter from "./routes/pending-connections.js";` with the other router imports, and `app.use("/api/connections/pending", pendingConnectionsRouter);` next to the other `app.use("/api/...")` lines (placement among them doesn't matter — none of the existing mounts overlap this path).

- [ ] **Step 5: Run tests and type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/routes/pending-connections.test.ts test/lib/pending-connections.test.ts test/routes/integrations.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/pending-connections.ts server/src/index.ts server/test/routes/pending-connections.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add GET and select routes for pending connections

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — the pick-accounts page

**Files:**
- Create: `src/pages/connect-pick-accounts.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError` (`src/lib/api.ts`, from plan 1); backend `GET /api/connections/pending/:id` and `POST /api/connections/pending/:id/select` (Task 5).
- Produces: route `/connect/pick-accounts` rendering `ConnectPickAccounts`, reading `?pending=<id>` from the URL.

Before starting, run `npm run lint 2>&1 | grep -c "warning"` and record the baseline.

- [ ] **Step 1: Create the page**

Create `src/pages/connect-pick-accounts.tsx`:

```tsx
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api";

interface Candidate {
  id: string;
  label: string;
}

interface PendingInfo {
  platform: string;
  clientId: string | null;
  candidates?: Candidate[];
}

export default function ConnectPickAccounts() {
  const [params] = useSearchParams();
  const pendingId = params.get("pending");
  const navigate = useNavigate();

  const [info, setInfo] = React.useState<PendingInfo | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [selectError, setSelectError] = React.useState<string | null>(null);

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
    if (!pendingId || !selected) return;
    setBusy(true);
    setSelectError(null);
    try {
      await apiFetch(`/api/connections/pending/${pendingId}/select`, {
        method: "POST",
        body: JSON.stringify({ externalAccountId: selected }),
      });
      navigate("/manage-clients?connection=success");
    } catch (err) {
      setSelectError(err instanceof ApiError ? err.message : "Failed to connect. Please try again.");
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
          <CardTitle>Choose an ad account</CardTitle>
          <CardDescription>This Meta login has access to more than one ad account. Pick the one to connect.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 px-5 pb-5">
          {(info.candidates ?? []).map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle p-2.5 text-[12.5px] has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
            >
              <input
                type="radio"
                name="ad-account"
                value={c.id}
                checked={selected === c.id}
                onChange={() => setSelected(c.id)}
              />
              {c.label}
            </label>
          ))}
          {selectError && (
            <p role="alert" className="text-[11px] text-negative">
              {selectError}
            </p>
          )}
          <Button className="w-full" disabled={!selected || busy} onClick={confirm}>
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
1. Add `const ConnectPickAccounts = lazy(() => import("@/pages/connect-pick-accounts"));` with the other lazy imports.
2. Add `<Route path="/connect/pick-accounts" element={<ConnectPickAccounts />} />` INSIDE `<Route element={<RequireAuth />}>` but OUTSIDE `<Route element={<AppShell />}>` — this page must require login (it acts on a specific client's data) but should NOT render inside the sidebar/topbar shell, since it's a focused one-step flow, not a dashboard page. Concretely:

```tsx
              <Route path="/login" element={<Login />} />
              <Route element={<RequireAuth />}>
                <Route path="/connect/pick-accounts" element={<ConnectPickAccounts />} />
                <Route element={<AppShell />}>
                  <Route path="/" element={<Dashboard />} />
                  ...
```

- [ ] **Step 3: Verify**

Run: `npm run build`
Expected: succeeds.

Run: `npm run lint 2>&1 | grep -c "warning"`
Expected: count no higher than the baseline from before Step 1; no new warning from `connect-pick-accounts.tsx` or `App.tsx`.

- [ ] **Step 4: Manual verification (honest reporting)**

If a Supabase session, backend, and a real Meta login with more than one ad account are available: click through Manage Clients → connect Meta → confirm the picker renders every account, selecting one and clicking Connect lands back on Manage Clients with the chosen account shown as Connected. If not available, state explicitly which of these were NOT verified — do not claim them.

- [ ] **Step 5: Commit**

```bash
git add src/pages/connect-pick-accounts.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat: add the Meta ad-account picker page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification, operator setup docs, real-account checklist, graph refresh

**Files:**
- Modify: `server/.env.example` (add `META_LOGIN_CONFIG_ID`)
- No other source changes expected.

- [ ] **Step 1: Document the new env var**

Read `server/.env.example` first. Add `META_LOGIN_CONFIG_ID=` on its own line, directly after the existing `META_APP_ID`/`META_APP_SECRET` lines, with a one-line comment above it: `# Facebook Login for Business Configuration ID — create it in the Meta App Dashboard under Facebook Login for Business > Configurations (see the plan's operator checklist below)`.

- [ ] **Step 2: Run the whole server suite and type-check**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: type-check clean; every test file passes.

- [ ] **Step 3: Frontend checks**

Run: `npm run build && npm run lint 2>&1 | grep -c "warning"`
Expected: build succeeds; count not above the pre-plan baseline.

- [ ] **Step 4: Secrets check**

Run: `git grep -n "very-secret\|chosen-token\|meta-token" -- server/src src`
Expected: no matches outside test files.

- [ ] **Step 5: Refresh the knowledge graph**

Run: `graphify update .`
Expected: completes without error. Then `git status --short graphify-out | head`. If tracked files changed, commit only `graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json`:

```bash
git add graphify-out/graph.json graphify-out/GRAPH_REPORT.md graphify-out/manifest.json
git commit -m "$(cat <<'EOF'
chore: refresh graphify graph after Meta Login for Business

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Write the operator setup + real-account checklist into your report**

Write these into your final report verbatim, in this order, and say plainly none was performed:

1. **Operator setup (must happen before this feature works at all):** in the Meta App Dashboard, add the "Facebook Login for Business" product, create a Configuration under Configurations (choose the asset types/permissions needed — at minimum `ads_read` and access to Ad Accounts; choose the access token type — System-user is preferred since it does not expire, per the spec), copy its Configuration ID, and set `META_LOGIN_CONFIG_ID` in the deployed environment.
2. Connect a real Meta Business Manager account that has access to exactly ONE ad account; confirm it connects directly with no picker shown (unchanged behavior).
3. Connect a real Meta Business Manager account that has access to MORE THAN ONE ad account; confirm the picker page lists every account with the correct names, selecting one connects it, and it shows up correctly on the Integrations panel.
4. Confirm whether Meta accepts or rejects the request when both `config_id` and `scope=ads_read` are present together (this plan kept `scope` defensively; if Meta errors or silently ignores one, note it and fix `getAuthUrl`).
5. If the Configuration was set to issue a System-user token, confirm on a real connection that `expiresAt` comes back `undefined`/null and the connection never needs re-authentication; if it was set to User type, confirm the existing expiry handling still triggers reconnection correctly when the token lapses.
6. Confirm an expired or already-claimed pending link shows "This link expired, please connect again" and that navigating there while logged out redirects to `/login` first (via `RequireAuth`), not to the picker.

- [ ] **Step 7: Report**

Summarize for the user: what shipped, exact test/build results, which manual states in Task 6 were verified vs not, and the six-item operator-setup-and-real-account checklist from Step 6.
