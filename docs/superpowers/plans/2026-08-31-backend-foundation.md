# Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the backend foundation — database schema, Supabase Auth-verified API, access control, encrypted credential storage, the shared platform-connector interface, and the billing data model with a stubbed payment gateway — so that Shopify/Meta/Google integration plans (each its own follow-up plan) have a working base to build on.

**Architecture:** One Node.js/Express API server (`server/`) in this repo, deployed to Railway. Supabase provides Postgres (accessed via a plain `DATABASE_URL` connection, not the Supabase SDK, so any Postgres migration tooling works) and Auth (JWTs verified manually against the project's JWT secret — no Supabase SDK dependency on the backend). Schema is plain SQL migrations run with `node-pg-migrate`.

**Tech Stack:** Node.js, TypeScript, Express, `pg`, `node-pg-migrate`, `jsonwebtoken`, Vitest + Supertest for tests, Node's built-in `crypto` for credential encryption.

**Spec:** [docs/superpowers/specs/2026-08-31-backend-integrations-design.md](../specs/2026-08-31-backend-integrations-design.md)

## Global Constraints

- Every integration (Shopify, Meta, Google, courier) implements the same `Connector` interface: `getAuthUrl()`, `handleCallback()`, `sync()`, `disconnect()`.
- OAuth tokens are encrypted at rest (AES-256-GCM) and are **never** included in any API response — verified by test, not just by convention.
- Raw platform data in, aggregates computed at query time — no column ever stores a value that's really a computation over other rows (e.g. no stored `order_count`; count `shopify_orders` instead).
- Every API error response has the shape `{ "error": { "code": string, "message": string } }`.
- A failed sync flips `platform_connections.status` to `error` with a reason in `metadata` — it never fails silently or retries forever unattended.
- No real payment gateway integration in this plan — `PaymentGateway` is an interface with a stub implementation only.
- Client access is always scoped through `team_members`/`team_member_clients` — no endpoint returns data for a client the requesting user can't access.

---

## File Structure

```
server/
  package.json
  tsconfig.json
  .env.example
  vitest.config.ts
  migrations/
    001_init_schema.sql
  src/
    index.ts                     # Express app entrypoint (Task 1)
    db.ts                        # pg Pool, shared by all routes (Task 2)
    middleware/
      auth.ts                    # requireAuth JWT middleware (Task 3)
    lib/
      access.ts                  # getAccessibleClientIds (Task 4)
      crypto.ts                  # encryptToken/decryptToken (Task 6)
      http-error.ts              # shared error response shape (Task 1)
    integrations/
      types.ts                   # Connector interface (Task 7)
      payment-gateway.ts         # PaymentGateway interface + stub (Task 9)
    routes/
      clients.ts                 # GET /api/clients (Task 5)
      connections.ts              # GET /api/clients/:id/connections (Task 7)
      billing.ts                  # subscription endpoints (Task 8, 9)
      couriers.ts                  # GET /api/couriers (Task 10)
  test/
    helpers/
      test-db.ts                 # seed/reset helpers shared by integration tests (Task 2)
      test-jwt.ts                 # sign a test JWT with the same secret (Task 3)
    db.test.ts                   # Task 2
    middleware/auth.test.ts      # Task 3
    lib/access.test.ts           # Task 4
    lib/crypto.test.ts           # Task 6
    routes/clients.test.ts       # Task 5
    routes/connections.test.ts   # Task 7
    routes/billing.test.ts       # Task 8, 9
    routes/couriers.test.ts      # Task 10
```

**Requires a real Postgres reachable via `TEST_DATABASE_URL` for every integration test in this plan** (a local `postgres` container is enough — this can be the actual Supabase project's connection string once provisioned, or any throwaway local Postgres for now). Every task below that touches the database says exactly how to point it at one.

---

### Task 1: Scaffold the server project

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/.env.example`
- Create: `server/vitest.config.ts`
- Create: `server/src/lib/http-error.ts`
- Create: `server/src/index.ts`
- Test: `server/test/health.test.ts`

**Interfaces:**
- Produces: `HttpError` class (`server/src/lib/http-error.ts`) — `new HttpError(status: number, code: string, message: string)`, used by every later route to produce the `{ error: { code, message } }` shape.
- Produces: `app` (default export of `server/src/index.ts`) — an Express `Application`, imported by every route test via Supertest.

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "d2c-backend",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "migrate": "node-pg-migrate"
  },
  "dependencies": {
    "express": "^4.21.1",
    "pg": "^8.13.1",
    "jsonwebtoken": "^9.0.2",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "@types/supertest": "^6.0.2",
    "node-pg-migrate": "^7.9.1",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/.env.example`**

```bash
PORT=4000
DATABASE_URL=postgres://user:password@localhost:5432/d2c
TEST_DATABASE_URL=postgres://user:password@localhost:5432/d2c_test
SUPABASE_JWT_SECRET=replace-with-supabase-project-jwt-secret
CREDENTIAL_ENCRYPTION_KEY=replace-with-32-byte-hex-key
```

- [ ] **Step 4: Create `server/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 20000,
  },
});
```

- [ ] **Step 5: Write the failing test for the health endpoint**

Create `server/test/health.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../src/index.js";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
cd server && npm install && npm test
```
Expected: FAIL — `src/index.ts` does not exist yet.

- [ ] **Step 7: Write `server/src/lib/http-error.ts`**

```typescript
export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toBody() {
    return { error: { code: this.code, message: this.message } };
  }
}
```

- [ ] **Step 8: Write `server/src/index.ts`**

```typescript
import express from "express";
import { HttpError } from "./lib/http-error.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
});

export default app;

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`server listening on ${port}`));
}
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
cd server && npm test
```
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/package.json server/tsconfig.json server/.env.example server/vitest.config.ts server/src/lib/http-error.ts server/src/index.ts server/test/health.test.ts
git commit -m "feat(server): scaffold Express app with health check"
```

---

### Task 2: Database schema migration

**Files:**
- Create: `server/migrations/001_init_schema.sql`
- Create: `server/src/db.ts`
- Create: `server/test/helpers/test-db.ts`
- Test: `server/test/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pool` (default export of `server/src/db.ts`) — a `pg.Pool` connected via `DATABASE_URL`, used by every route from Task 5 onward.
- Produces: `resetTestDb(): Promise<void>` and `testPool: pg.Pool` (`server/test/helpers/test-db.ts`) — every later integration test imports these to get a clean, migrated database before each test.

- [ ] **Step 1: Write the failing test asserting the schema exists**

Create `server/test/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

const expectedTables = [
  "team_members",
  "team_member_clients",
  "clients",
  "plans",
  "subscriptions",
  "invoices",
  "platform_connections",
  "sync_logs",
  "shopify_orders",
  "shopify_order_line_items",
  "meta_campaign_metrics",
  "google_campaign_metrics",
  "courier_shipments",
];

describe("schema", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it.each(expectedTables)("creates table %s", async (table) => {
    const res = await testPool.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = $1",
      [table],
    );
    expect(res.rowCount).toBe(1);
  });

  it("enforces one connection per (client_id, platform, external_account_id)", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ('c1', 'Test Client', 'Fashion', 'bg-violet-500', 'T', null)`,
    );
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')`,
    );
    await expect(
      testPool.query(
        `insert into platform_connections (client_id, platform, status, external_account_id)
         values ('c1', 'shopify', 'connected', 'shop-1.myshopify.com')`,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test -- db.test.ts
```
Expected: FAIL — `server/test/helpers/test-db.ts` does not exist yet.

- [ ] **Step 3: Write `server/src/db.ts`**

```typescript
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export default pool;
```

- [ ] **Step 4: Write `server/migrations/001_init_schema.sql`**

```sql
create table team_members (
  id uuid primary key,
  name text not null,
  email text not null unique,
  role text not null check (role in ('owner', 'manager', 'marketer', 'team_member')),
  all_client_access boolean not null default false,
  created_at timestamptz not null default now()
);

create table clients (
  id text primary key,
  name text not null,
  category text not null,
  logo_color text not null,
  logo_initial text not null,
  owner_id uuid references team_members(id),
  created_at timestamptz not null default now()
);

create table team_member_clients (
  team_member_id uuid not null references team_members(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  primary key (team_member_id, client_id)
);

create table plans (
  id text primary key,
  name text not null,
  order_limit integer,
  monthly_fee_inr integer not null,
  included_meta_accounts integer not null,
  included_google_accounts integer not null
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique references clients(id) on delete cascade,
  plan_id text not null references plans(id),
  status text not null check (status in ('active', 'past_due', 'canceled', 'trialing')),
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default now() + interval '30 days',
  extra_shopify_stores integer not null default 0,
  extra_meta_accounts integer not null default 0,
  extra_google_accounts integer not null default 0,
  gateway_customer_id text,
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  amount_inr integer not null,
  status text not null check (status in ('pending', 'paid', 'failed')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  gateway_payment_id text,
  created_at timestamptz not null default now()
);

create table platform_connections (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  platform text not null check (platform in ('shopify', 'meta', 'google', 'courier_delhivery', 'courier_shadowfax')),
  status text not null check (status in ('connected', 'disconnected', 'error')),
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  external_account_id text not null,
  metadata jsonb not null default '{}',
  last_synced_at timestamptz,
  connected_by uuid references team_members(id),
  created_at timestamptz not null default now(),
  unique (client_id, platform, external_account_id)
);

create table sync_logs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references platform_connections(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_synced integer,
  error text
);

create table shopify_orders (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  shopify_order_id text not null,
  customer_name text not null,
  order_date timestamptz not null,
  amount integer not null,
  status text not null,
  payment_method text not null,
  city text,
  state text,
  courier text,
  synced_at timestamptz not null default now(),
  unique (connection_id, shopify_order_id)
);

create table shopify_order_line_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references shopify_orders(id) on delete cascade,
  product_name text not null,
  quantity integer not null,
  price integer not null
);

create table meta_campaign_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  campaign_id text not null,
  campaign_name text not null,
  metric_date date not null,
  spend integer not null,
  impressions integer not null,
  clicks integer not null,
  results integer not null,
  synced_at timestamptz not null default now(),
  unique (connection_id, campaign_id, metric_date)
);

create table google_campaign_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  campaign_id text not null,
  campaign_name text not null,
  metric_date date not null,
  spend integer not null,
  impressions integer not null,
  clicks integer not null,
  conversions integer not null,
  synced_at timestamptz not null default now(),
  unique (connection_id, campaign_id, metric_date)
);

create table courier_shipments (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  connection_id uuid not null references platform_connections(id) on delete cascade,
  order_reference text not null,
  status text not null,
  synced_at timestamptz not null default now()
);
```

- [ ] **Step 5: Write `server/test/helpers/test-db.ts`**

```typescript
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(__dirname, "../../migrations/001_init_schema.sql"), "utf-8");

export const testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

export async function resetTestDb() {
  await testPool.query(`
    drop schema public cascade;
    create schema public;
    create extension if not exists pgcrypto;
  `);
  await testPool.query(migrationSql);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Requires `TEST_DATABASE_URL` set to a real Postgres (e.g. `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16` and `postgres://postgres:postgres@localhost:5432/postgres`):

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- db.test.ts
```
Expected: PASS — all 13 tables found, duplicate-connection insert rejected.

- [ ] **Step 7: Commit**

```bash
git add server/migrations/001_init_schema.sql server/src/db.ts server/test/helpers/test-db.ts server/test/db.test.ts
git commit -m "feat(server): add database schema migration"
```

---

### Task 3: Supabase Auth JWT verification middleware

**Files:**
- Create: `server/src/middleware/auth.ts`
- Create: `server/test/helpers/test-jwt.ts`
- Test: `server/test/middleware/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `requireAuth` (named export, `server/src/middleware/auth.ts`) — Express middleware; on success sets `req.auth = { userId: string, email: string }`; on failure calls `next(new HttpError(401, "unauthorized", ...))`.
- Produces: `signTestJwt(payload: { sub: string; email: string }): string` (`server/test/helpers/test-jwt.ts`) — every later route test uses this to authenticate as a given user.

- [ ] **Step 1: Write the failing test**

Create `server/test/middleware/auth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireAuth } from "../../src/middleware/auth.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { HttpError } from "../../src/lib/http-error.js";

function buildApp() {
  const app = express();
  app.get("/protected", requireAuth, (req, res) => {
    res.json({ userId: req.auth!.userId });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.toBody());
      return;
    }
    res.status(500).json({ error: { code: "internal_error", message: "unexpected" } });
  });
  return app;
}

describe("requireAuth", () => {
  it("rejects requests with no Authorization header", async () => {
    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects an invalid token", async () => {
    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("accepts a validly signed token and attaches req.auth", async () => {
    const token = signTestJwt({ sub: "user-123", email: "riya@agency.com" });
    const res = await request(buildApp()).get("/protected").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("user-123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test -- middleware/auth.test.ts
```
Expected: FAIL — `src/middleware/auth.ts` and `test/helpers/test-jwt.ts` don't exist yet.

- [ ] **Step 3: Write `server/test/helpers/test-jwt.ts`**

```typescript
import jwt from "jsonwebtoken";

export function signTestJwt(payload: { sub: string; email: string }) {
  const secret = process.env.SUPABASE_JWT_SECRET ?? "test-secret";
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "1h" });
}
```

- [ ] **Step 4: Write `server/src/middleware/auth.ts`**

```typescript
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { HttpError } from "../lib/http-error.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string };
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    next(new HttpError(401, "unauthorized", "Missing bearer token"));
    return;
  }
  const token = header.slice("Bearer ".length);
  const secret = process.env.SUPABASE_JWT_SECRET ?? "test-secret";
  try {
    const decoded = jwt.verify(token, secret) as { sub: string; email: string };
    req.auth = { userId: decoded.sub, email: decoded.email };
    next();
  } catch {
    next(new HttpError(401, "unauthorized", "Invalid or expired token"));
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && npm test -- middleware/auth.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/middleware/auth.ts server/test/helpers/test-jwt.ts server/test/middleware/auth.test.ts
git commit -m "feat(server): add Supabase JWT auth middleware"
```

---

### Task 4: Client access scoping

**Files:**
- Create: `server/src/lib/access.ts`
- Test: `server/test/lib/access.test.ts`

**Interfaces:**
- Consumes: `pool` from `server/src/db.ts` (or `testPool` in tests, passed in directly).
- Produces: `getAccessibleClientIds(db: pg.Pool, userId: string): Promise<"all" | string[]>` — Task 5's `/api/clients` route and every later per-client route call this to decide what a user may see.

- [ ] **Step 1: Write the failing test**

Create `server/test/lib/access.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { getAccessibleClientIds } from "../../src/lib/access.js";

describe("getAccessibleClientIds", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion', 'bg-violet-500', 'A'),
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values
       ('22222222-2222-2222-2222-222222222222', 'abc-fashion')`,
    );
  });

  it("returns 'all' for a user with all_client_access", async () => {
    const result = await getAccessibleClientIds(testPool, "11111111-1111-1111-1111-111111111111");
    expect(result).toBe("all");
  });

  it("returns only assigned client ids for a scoped user", async () => {
    const result = await getAccessibleClientIds(testPool, "22222222-2222-2222-2222-222222222222");
    expect(result).toEqual(["abc-fashion"]);
  });

  it("returns an empty array for an unknown user", async () => {
    const result = await getAccessibleClientIds(testPool, "33333333-3333-3333-3333-333333333333");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- lib/access.test.ts
```
Expected: FAIL — `src/lib/access.ts` doesn't exist yet.

- [ ] **Step 3: Write `server/src/lib/access.ts`**

```typescript
import type pg from "pg";

export async function getAccessibleClientIds(db: pg.Pool, userId: string): Promise<"all" | string[]> {
  const member = await db.query<{ all_client_access: boolean }>(
    "select all_client_access from team_members where id = $1",
    [userId],
  );
  if (member.rowCount === 0) return [];
  if (member.rows[0].all_client_access) return "all";

  const scoped = await db.query<{ client_id: string }>(
    "select client_id from team_member_clients where team_member_id = $1",
    [userId],
  );
  return scoped.rows.map((r) => r.client_id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- lib/access.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/access.ts server/test/lib/access.test.ts
git commit -m "feat(server): add client access scoping helper"
```

---

### Task 5: `GET /api/clients`

**Files:**
- Create: `server/src/routes/clients.ts`
- Modify: `server/src/index.ts:1-20` (mount the router)
- Test: `server/test/routes/clients.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task 3), `getAccessibleClientIds` (Task 4), `pool` (Task 2).
- Produces: `clientsRouter` (default export, `server/src/routes/clients.ts`) — mounted at `/api/clients`. Response shape: `{ id, name, category, logoColor, logoInitial, owner, status }[]`, matching the frontend's existing `Client` type in `src/data/types.ts` so the frontend swap in a later plan is mechanical.

- [ ] **Step 1: Write the failing test**

Create `server/test/routes/clients.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/clients", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A', '11111111-1111-1111-1111-111111111111'),
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty & Cosmetics', 'bg-rose-500', 'X', '11111111-1111-1111-1111-111111111111')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values
       ('22222222-2222-2222-2222-222222222222', 'abc-fashion')`,
    );
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/clients");
    expect(res.status).toBe(401);
  });

  it("returns all clients for a user with all_client_access", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app).get("/api/clients").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id).sort()).toEqual(["abc-fashion", "xyz-cosmetics"]);
    expect(res.body[0]).toMatchObject({ logoColor: expect.any(String), logoInitial: expect.any(String) });
    // owner must be the person's display name, not their raw id — the frontend
    // renders this value directly (e.g. Manage Clients' "Owner" column)
    expect(res.body[0].owner).toBe("Riya Kapoor");
  });

  it("returns only scoped clients for a limited user", async () => {
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "aditya@agency.com" });
    const res = await request(app).get("/api/clients").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(["abc-fashion"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/clients.test.ts
```
Expected: FAIL — 404, route not mounted yet.

- [ ] **Step 3: Write `server/src/routes/clients.ts`**

```typescript
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";

const router = Router();

const SELECT_CLIENTS = `
  select c.*, tm.name as owner_name
  from clients c
  left join team_members tm on tm.id = c.owner_id
`;

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
    const rows =
      accessible === "all"
        ? (await pool.query(`${SELECT_CLIENTS} order by c.name`)).rows
        : accessible.length === 0
          ? []
          : (await pool.query(`${SELECT_CLIENTS} where c.id = any($1) order by c.name`, [accessible])).rows;

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        logoColor: r.logo_color,
        logoInitial: r.logo_initial,
        owner: r.owner_name,
        status: "healthy", // computed status lands with the Shopify integration plan, once real order data exists
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Wire it into `server/src/index.ts`**

Modify `server/src/index.ts`, adding the import and mount right after `app.use(express.json())`:

```typescript
import clientsRouter from "./routes/clients.js";
// ...
app.use(express.json());
app.use("/api/clients", clientsRouter);
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/clients.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/clients.ts server/src/index.ts server/test/routes/clients.test.ts
git commit -m "feat(server): add GET /api/clients"
```

---

### Task 6: Credential encryption utility

**Files:**
- Create: `server/src/lib/crypto.ts`
- Test: `server/test/lib/crypto.test.ts`

**Interfaces:**
- Consumes: `CREDENTIAL_ENCRYPTION_KEY` env var (32-byte hex string).
- Produces: `encryptToken(plaintext: string): string` and `decryptToken(ciphertext: string): string` (`server/src/lib/crypto.ts`) — every integration plan's OAuth callback handler uses these before writing to `platform_connections.access_token`/`refresh_token`.

- [ ] **Step 1: Write the failing test**

Create `server/test/lib/crypto.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken } from "../../src/lib/crypto.js";

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64); // 32 bytes hex, test-only key
});

describe("token encryption", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptToken("shpat_super_secret_token");
    expect(ciphertext).not.toContain("shpat_super_secret_token");
    expect(decryptToken(ciphertext)).toBe("shpat_super_secret_token");
  });

  it("produces different ciphertext for the same plaintext each time", () => {
    const a = encryptToken("same-value");
    const b = encryptToken("same-value");
    expect(a).not.toBe(b);
  });

  it("throws if the ciphertext has been tampered with", () => {
    const ciphertext = encryptToken("shpat_super_secret_token");
    const tampered = ciphertext.slice(0, -2) + "00";
    expect(() => decryptToken(tampered)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test -- lib/crypto.test.ts
```
Expected: FAIL — `src/lib/crypto.ts` doesn't exist yet.

- [ ] **Step 3: Write `server/src/lib/crypto.ts`**

```typescript
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 32-byte (64 hex char) value");
  }
  return Buffer.from(hex, "hex");
}

// Format: base64(iv) . base64(authTag) . base64(ciphertext)
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(stored: string): string {
  const [ivB64, authTagB64, ciphertextB64] = stored.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npm test -- lib/crypto.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/crypto.ts server/test/lib/crypto.test.ts
git commit -m "feat(server): add AES-256-GCM credential encryption"
```

---

### Task 7: Connector interface + `GET /api/clients/:id/connections`

**Files:**
- Create: `server/src/integrations/types.ts`
- Create: `server/src/routes/connections.ts`
- Modify: `server/src/index.ts` (mount the router)
- Test: `server/test/routes/connections.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `getAccessibleClientIds`, `pool`, `encryptToken`/`decryptToken`.
- Produces: `Connector` interface (`server/src/integrations/types.ts`) — every future integration plan (Shopify, Meta, Google, courier) implements this exact shape:
  ```typescript
  interface Connector {
    platform: string;
    getAuthUrl(clientId: string, state: string): string;
    handleCallback(query: Record<string, string>): Promise<{ externalAccountId: string; accessToken: string; refreshToken?: string; expiresAt?: Date }>;
    sync(connectionId: string): Promise<{ recordsSynced: number }>;
    disconnect(connectionId: string): Promise<void>;
  }
  ```
- Produces: `connectionsRouter` mounted at `/api/clients/:id/connections`. Response shape never includes `access_token`/`refresh_token`.

- [ ] **Step 1: Write the failing test**

Create `server/test/routes/connections.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { encryptToken } from "../../src/lib/crypto.js";

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

describe("GET /api/clients/:id/connections", () => {
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
      `insert into platform_connections (client_id, platform, status, access_token, external_account_id) values
       ('abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_secret")],
    );
  });

  it("returns connections without exposing tokens", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/connections")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      platform: "shopify",
      status: "connected",
      externalAccountId: "abc-fashion.myshopify.com",
    });
    expect(res.body[0].accessToken).toBeUndefined();
    expect(res.body[0].access_token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("shpat_secret");
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/connections")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/connections.test.ts
```
Expected: FAIL — route not mounted yet.

- [ ] **Step 3: Write `server/src/integrations/types.ts`**

```typescript
export interface Connector {
  platform: string;
  getAuthUrl(clientId: string, state: string): string;
  handleCallback(query: Record<string, string>): Promise<{
    externalAccountId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;
  sync(connectionId: string): Promise<{ recordsSynced: number }>;
  disconnect(connectionId: string): Promise<void>;
}
```

- [ ] **Step 4: Write `server/src/routes/connections.ts`**

```typescript
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

async function assertClientAccess(userId: string, clientId: string) {
  const accessible = await getAccessibleClientIds(pool, userId);
  if (accessible === "all") return;
  if (!accessible.includes(clientId)) {
    throw new HttpError(404, "not_found", "Client not found");
  }
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    await assertClientAccess(req.auth!.userId, req.params.id);
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

export default router;
```

- [ ] **Step 5: Wire it into `server/src/index.ts`**

Modify `server/src/index.ts`:

```typescript
import connectionsRouter from "./routes/connections.js";
// ...
app.use("/api/clients/:id/connections", connectionsRouter);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/connections.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/integrations/types.ts server/src/routes/connections.ts server/src/index.ts server/test/routes/connections.test.ts
git commit -m "feat(server): add Connector interface and GET connections endpoint"
```

---

### Task 8: Plans seed + `GET /api/clients/:id/subscription`

**Files:**
- Modify: `server/migrations/001_init_schema.sql` (append seed inserts — schema and seed data for a fixed reference table belong in the same migration)
- Create: `server/src/routes/billing.ts`
- Modify: `server/src/index.ts` (mount the router)
- Test: `server/test/routes/billing.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `getAccessibleClientIds`, `pool`.
- Produces: `billingRouter` mounted at `/api/clients/:id/subscription`, `GET` returns `{ plan: {...}, subscription: {...} | null, overOrderLimit: boolean }`.

- [ ] **Step 1: Append plan seed rows to `server/migrations/001_init_schema.sql`**

Add at the end of the file, after the `courier_shipments` table:

```sql
insert into plans (id, name, order_limit, monthly_fee_inr, included_meta_accounts, included_google_accounts) values
  ('small', 'Small', 300, 1499, 1, 1),
  ('medium', 'Medium', 1500, 2999, 2, 2),
  ('large', 'Large', 5000, 5999, 4, 4),
  ('enterprise', 'Enterprise', null, 9999, 0, 0);
```

- [ ] **Step 2: Write the failing test**

Create `server/test/routes/billing.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/clients/:id/subscription", () => {
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
  });

  it("returns plans list even with no subscription yet", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toBeNull();
  });

  it("flags overOrderLimit when order count exceeds the plan limit", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'small', 'active')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('99999999-9999-9999-9999-999999999999', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
    );
    const orderInserts = Array.from({ length: 301 }, (_, i) =>
      testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method)
         values ('abc-fashion', '99999999-9999-9999-9999-999999999999', $1, 'Test Customer', now(), 1000, 'Delivered', 'Prepaid')`,
        [`order-${i}`],
      ),
    );
    await Promise.all(orderInserts);

    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe("small");
    expect(res.body.overOrderLimit).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/billing.test.ts
```
Expected: FAIL — route not mounted yet.

- [ ] **Step 4: Write `server/src/routes/billing.ts`**

```typescript
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

async function assertClientAccess(userId: string, clientId: string) {
  const accessible = await getAccessibleClientIds(pool, userId);
  if (accessible === "all") return;
  if (!accessible.includes(clientId)) {
    throw new HttpError(404, "not_found", "Client not found");
  }
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(req.auth!.userId, clientId);

    const subResult = await pool.query(
      `select s.*, p.name as plan_name, p.order_limit, p.monthly_fee_inr, p.included_meta_accounts, p.included_google_accounts
       from subscriptions s join plans p on p.id = s.plan_id where s.client_id = $1`,
      [clientId],
    );

    if (subResult.rowCount === 0) {
      const plans = await pool.query("select * from plans order by monthly_fee_inr");
      res.json({ plan: null, subscription: null, overOrderLimit: false, availablePlans: plans.rows });
      return;
    }

    const sub = subResult.rows[0];
    const orderCount = await pool.query(
      `select count(*)::int as count from shopify_orders
       where client_id = $1 and order_date >= $2`,
      [clientId, sub.current_period_start],
    );

    res.json({
      plan: {
        id: sub.plan_id,
        name: sub.plan_name,
        orderLimit: sub.order_limit,
        monthlyFeeInr: sub.monthly_fee_inr,
        includedMetaAccounts: sub.included_meta_accounts,
        includedGoogleAccounts: sub.included_google_accounts,
      },
      subscription: {
        status: sub.status,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        extraShopifyStores: sub.extra_shopify_stores,
        extraMetaAccounts: sub.extra_meta_accounts,
        extraGoogleAccounts: sub.extra_google_accounts,
      },
      overOrderLimit: sub.order_limit !== null && orderCount.rows[0].count > sub.order_limit,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 5: Wire it into `server/src/index.ts`**

```typescript
import billingRouter from "./routes/billing.js";
// ...
app.use("/api/clients/:id/subscription", billingRouter);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/billing.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/migrations/001_init_schema.sql server/src/routes/billing.ts server/src/index.ts server/test/routes/billing.test.ts
git commit -m "feat(server): seed plans and add GET subscription endpoint"
```

---

### Task 9: Stub payment gateway + `POST /api/clients/:id/subscription`

**Files:**
- Create: `server/src/integrations/payment-gateway.ts`
- Modify: `server/src/routes/billing.ts:1-10` (add the POST handler)
- Test: `server/test/routes/billing.test.ts` (append cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `PaymentGateway` interface + `stubPaymentGateway` (`server/src/integrations/payment-gateway.ts`) — `createSubscription(clientId, planId): Promise<{ gatewayCustomerId: string | null }>`, `chargeInvoice(invoiceId): Promise<{ status: "paid" | "failed" }>`, `cancelSubscription(subscriptionId): Promise<void>`. A future real-gateway plan implements this same interface and swaps the import in `billing.ts` — no other file changes.

- [ ] **Step 1: Write the failing test (append to `server/test/routes/billing.test.ts`)**

Add this `describe` block to the existing file:

```typescript
describe("POST /api/clients/:id/subscription", () => {
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
  });

  it("creates a subscription and a pending invoice via the stub gateway", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "medium" });

    expect(res.status).toBe(201);
    expect(res.body.subscription.status).toBe("active");

    const invoices = await testPool.query("select * from invoices");
    expect(invoices.rowCount).toBe(1);
    expect(invoices.rows[0].status).toBe("pending");
    expect(invoices.rows[0].amount_inr).toBe(2999);
  });

  it("rejects an unknown plan id", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/subscription")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "does-not-exist" });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/billing.test.ts
```
Expected: FAIL — no `POST` handler yet.

- [ ] **Step 3: Write `server/src/integrations/payment-gateway.ts`**

```typescript
export interface PaymentGateway {
  createSubscription(clientId: string, planId: string): Promise<{ gatewayCustomerId: string | null }>;
  chargeInvoice(invoiceId: string): Promise<{ status: "paid" | "failed" }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

export const stubPaymentGateway: PaymentGateway = {
  async createSubscription(clientId, planId) {
    console.log(`[stub payment gateway] would create subscription for ${clientId} on plan ${planId}`);
    return { gatewayCustomerId: null };
  },
  async chargeInvoice(invoiceId) {
    console.log(`[stub payment gateway] would charge invoice ${invoiceId} — leaving as pending`);
    return { status: "failed" };
  },
  async cancelSubscription(subscriptionId) {
    console.log(`[stub payment gateway] would cancel subscription ${subscriptionId}`);
  },
};
```

- [ ] **Step 4: Add the `POST` handler to `server/src/routes/billing.ts`**

Add this route to the existing router in `server/src/routes/billing.ts`, after the `GET "/"` handler:

```typescript
import { stubPaymentGateway } from "../integrations/payment-gateway.js";

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(req.auth!.userId, clientId);

    const { planId } = req.body as { planId?: string };
    const plan = await pool.query("select * from plans where id = $1", [planId]);
    if (plan.rowCount === 0) {
      throw new HttpError(400, "invalid_plan", `No plan with id ${planId}`);
    }

    const { gatewayCustomerId } = await stubPaymentGateway.createSubscription(clientId, planId!);

    const subResult = await pool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_customer_id)
       values ($1, $2, 'active', $3)
       on conflict (client_id) do update set plan_id = excluded.plan_id, status = 'active'
       returning *`,
      [clientId, planId, gatewayCustomerId],
    );
    const subscription = subResult.rows[0];

    await pool.query(
      `insert into invoices (subscription_id, amount_inr, status, period_start, period_end)
       values ($1, $2, 'pending', $3, $4)`,
      [subscription.id, plan.rows[0].monthly_fee_inr, subscription.current_period_start, subscription.current_period_end],
    );

    res.status(201).json({ subscription: { status: subscription.status, planId: subscription.plan_id } });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test -- routes/billing.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/integrations/payment-gateway.ts server/src/routes/billing.ts server/test/routes/billing.test.ts
git commit -m "feat(server): add stub payment gateway and POST subscription"
```

---

### Task 10: Courier picker scaffold

**Files:**
- Create: `server/src/routes/couriers.ts`
- Modify: `server/src/index.ts` (mount the router)
- Test: `server/test/routes/couriers.test.ts`

**Interfaces:**
- Consumes: `requireAuth`.
- Produces: `couriersRouter` mounted at `/api/couriers`, `GET` returns `{ id: string; name: string; available: boolean }[]`. A future courier integration plan flips `available` to `true` for that courier's `id` — no other change needed here.

- [ ] **Step 1: Write the failing test**

Create `server/test/routes/couriers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/couriers", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/couriers");
    expect(res.status).toBe(401);
  });

  it("lists known couriers, all unavailable for now", async () => {
    const token = signTestJwt({ sub: "any-user", email: "someone@agency.com" });
    const res = await request(app).get("/api/couriers").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "courier_delhivery", name: "Delhivery", available: false },
      { id: "courier_shadowfax", name: "Shadowfax", available: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test -- routes/couriers.test.ts
```
Expected: FAIL — route not mounted yet.

- [ ] **Step 3: Write `server/src/routes/couriers.ts`**

```typescript
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const KNOWN_COURIERS = [
  { id: "courier_delhivery", name: "Delhivery", available: false },
  { id: "courier_shadowfax", name: "Shadowfax", available: false },
];

router.get("/", requireAuth, (_req, res) => {
  res.json(KNOWN_COURIERS);
});

export default router;
```

- [ ] **Step 4: Wire it into `server/src/index.ts`**

```typescript
import couriersRouter from "./routes/couriers.js";
// ...
app.use("/api/couriers", couriersRouter);
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && npm test -- routes/couriers.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/couriers.ts server/src/index.ts server/test/routes/couriers.test.ts
git commit -m "feat(server): add courier picker scaffold"
```

---

### Task 11: Provision Supabase and connect the frontend

This task is different from the others — it requires you (not Claude) to create external accounts, and ends in a manually-verified deliverable rather than an automated test, since it's proving the whole stack talks to a real Supabase project rather than the local test database used above.

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/pages/login.tsx`
- Modify: `src/store/app-context.tsx` (replace the static `CLIENTS` import with a fetch to `/api/clients`, gated on Supabase session)
- Modify: `src/App.tsx` (add the `/login` route)

- [ ] **Step 1: Create the Supabase project (user action)**

Go to [supabase.com](https://supabase.com), create a new project. From Project Settings → API, copy:
- `Project URL` → becomes `SUPABASE_URL`
- `service_role` key → becomes `SUPABASE_SERVICE_ROLE_KEY` (server-side only, never in frontend code)
- `anon` key → becomes `VITE_SUPABASE_ANON_KEY` (safe for frontend)
- From Project Settings → API → JWT Settings, copy the `JWT Secret` → becomes `SUPABASE_JWT_SECRET`
- From Project Settings → Database, copy the connection string → becomes `DATABASE_URL`

- [ ] **Step 2: Fill in `server/.env` (not `.env.example` — this file is gitignored)**

```bash
cp server/.env.example server/.env
```

Fill in `DATABASE_URL` and `SUPABASE_JWT_SECRET` with the real values from Step 1. Generate `CREDENTIAL_ENCRYPTION_KEY` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- [ ] **Step 3: Run the migration against the real Supabase database**

```bash
cd server && npm run migrate up
```

- [ ] **Step 4: Create your first team member row**

In the Supabase dashboard, go to Authentication → Users → Add User, create yourself with an email/password. Copy the generated user UUID, then in the SQL editor run:

```sql
insert into team_members (id, name, email, role, all_client_access)
values ('<paste-uuid-here>', 'Your Name', 'your@email.com', 'owner', true);
```

- [ ] **Step 5: Install `@supabase/supabase-js` on the frontend**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 6: Add frontend env vars**

Create/edit `.env.local` in the repo root (gitignored):

```bash
VITE_SUPABASE_URL=<your project URL>
VITE_SUPABASE_ANON_KEY=<your anon key>
VITE_API_URL=http://localhost:4000
```

- [ ] **Step 7: Write `src/lib/supabase.ts`**

```typescript
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
```

- [ ] **Step 8: Write `src/pages/login.tsx`**

```tsx
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(signInError.message);
      return;
    }
    navigate("/");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">Sign in</h1>
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-[12.5px] text-negative">{error}</p>}
        <Button type="submit" className="w-full">Sign in</Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 9: Wire real clients into `src/store/app-context.tsx`**

Modify `src/store/app-context.tsx`: replace the `import { CLIENTS, DEFAULT_CLIENT_ID } from "@/data/mock";` line with `import type { Client } from "@/data/types";` (the `Client` type already exists there — this is what makes the swap mechanical) plus the Supabase-session-aware fetch below. Add near the top of `AppProvider`:

```typescript
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

// inside AppProvider, alongside the other useState calls:
const [session, setSession] = React.useState<Session | null>(null);
const [clients, setClients] = React.useState<Client[]>([]);

React.useEffect(() => {
  supabase.auth.getSession().then(({ data }) => setSession(data.session));
  const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession));
  return () => sub.subscription.unsubscribe();
}, []);

React.useEffect(() => {
  if (!session) return;
  fetch(`${import.meta.env.VITE_API_URL}/api/clients`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
    .then((r) => r.json())
    .then(setClients);
}, [session]);
```

Replace every reference to the imported `CLIENTS` constant in this file with the new `clients` state variable, and use `clients[0]?.id` in place of `DEFAULT_CLIENT_ID` for the initial `clientId` state.

- [ ] **Step 10: Add the `/login` route to `src/App.tsx`**

Add the lazy import and route:

```typescript
const Login = lazy(() => import("@/pages/login"));
// ...
<Route path="/login" element={<Login />} />
```

- [ ] **Step 11: Manually verify end-to-end**

Start both servers:

```bash
cd server && npm run dev
```

In a second terminal:

```bash
npm run dev
```

Navigate to `http://localhost:5173/#/login`, sign in with the credentials created in Step 4. Confirm you land on the Dashboard and the client selector shows the real (currently empty, or containing only clients you've manually inserted) list from Postgres — not the old mock `CLIENTS` array. Insert a second test client via the Supabase SQL editor, refresh, and confirm it appears without a code change.

- [ ] **Step 12: Commit**

```bash
git add src/lib/supabase.ts src/pages/login.tsx src/store/app-context.tsx src/App.tsx package.json package-lock.json
git commit -m "feat: connect frontend to Supabase Auth and real /api/clients"
```

---

## What comes after this plan

With this foundation in place, each of the following becomes its own plan document, built the same way (spec section already written, just needs its own task breakdown):

1. **Shopify integration plan** — implements `Connector` for Shopify, wires the generic `POST .../authorize` and `GET .../callback` dispatch routes (deliberately not built in this plan — they'd have no real connector to route to yet), writes the sync job, and replaces the remaining `mock.ts` functions (`getSalesSeries`, `getOrders`, `getProducts`, `getGeoBreakdown`) with real queries over `shopify_orders`. Also the first plan where Railway deployment matters, since Shopify's OAuth callback needs a real public HTTPS URL.
2. **Meta Ads integration plan** — same connect/sync pattern, `ads_read` scope, plus the hard block on connecting a Meta account beyond the plan's `included_meta_accounts + extra_meta_accounts` (the spec's ad-account limit enforcement — a check at connect-time, not something foundation could test without a real connector to attempt connecting with). Also adds the `campaign_notes` table (real notes people type, replacing the old scripted mock activity feed) and its endpoints.
3. **Google Ads integration plan** — same pattern as Meta, including its own account-limit enforcement.
4. **Tasks plan** — `GET/POST /api/tasks` becomes a real, persisted feature (a `tasks` table referencing `team_members` and `clients`, which already exist from this plan). Small and independent of any platform integration — could be built any time after this plan, not blocked on Shopify/Meta/Google.
5. Courier and real payment gateway integrations remain stubbed until their respective external prerequisites (API credentials, gateway account) exist.
