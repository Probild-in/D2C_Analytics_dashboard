# Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the engineering-side gaps in `docs/production-readiness.md` section C that don't depend on external credentials or decisions — CI, containerization, cross-process-safe scheduling, security headers, observability, and a batch of small deferred cleanups — without touching the payment gateway (blocked on a provider decision) or the Delhivery connector (blocked on real account access).

**Architecture:** Each task is additive and isolated — new files (Dockerfile, CI workflow, logger module) or small, targeted edits to existing files (scheduler.ts, index.ts). No task changes an existing API contract, database schema, or route behavior visible to the frontend. The live deployment (`probild-live` → `d2c.probild.in`, systemd + nginx) is unaffected by this plan unless and until the resulting branch is deployed the same way prior work was.

**Tech Stack:** Node 22, Express 4, TypeScript, Vitest, pino (new), helmet (new), GitHub Actions.

**Spec:** `docs/production-readiness.md` (the requirements document this plan implements section C of). Read it for context on what's deliberately excluded (payment gateway, Delhivery verification) and why.

## Global Constraints

- Node version for CI and Docker: **22** (matches the production server's `node -v`, confirmed `v22.18.0`).
- Server tests: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`. Type-check: `cd server && npx tsc --noEmit`.
- Frontend: `npm run build`, lint via `npm run lint 2>&1 | grep -c "warning"` — current baseline is **16** warnings; no task in this plan may raise that count.
- Do not modify `server/src/integrations/payment-gateway.ts`, any Meta/Google/Shopify/Delhivery/Shiprocket connector body, or any existing route's request/response shape.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` copied exactly.
- `console.log`/`console.error` are being replaced by a shared logger in Task 6 — tasks before Task 6 may still use `console.*` if they need a log line; Task 6 is the one that sweeps the rest.

---

### Task 1: Dockerfile for the server

**Files:**
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`

**Interfaces:**
- Produces: a buildable image (`docker build -t d2c-server ./server` from repo root context is NOT required — build context is `server/` itself) that runs `node dist/index.js` on port 4000 (overridable via `PORT` env var, already read by `index.ts`).

- [ ] **Step 1: Write `server/.dockerignore`**

```
node_modules
dist
*.log
.env
.env.*
!.env.example
test
```

- [ ] **Step 2: Write `server/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Verify the image builds**

Run: `cd server && docker build -t d2c-server-test .`
Expected: build succeeds (no errors). If Docker isn't available in this environment, run `npm ci && npm run build` directly in `server/` instead and confirm it succeeds — the Dockerfile's two RUN steps are exactly those two commands, so a passing manual run is equivalent evidence the Dockerfile's steps are correct. State in your report which verification method you used and why.

- [ ] **Step 4: Commit**

```bash
git add server/Dockerfile server/.dockerignore
git commit -m "feat(server): add a Dockerfile for the server

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1's Dockerfile is NOT used by this workflow (CI runs tests directly on the runner, not inside the container — faster and simpler for a project this size). Consumes nothing else new.
- Produces: a GitHub Actions workflow that runs on every push and pull request against `main` and any `probild-*` branch, running server tests+typecheck and frontend build+lint as separate jobs.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: ["main", "probild-*"]
  pull_request:
    branches: ["main", "probild-*"]

jobs:
  server:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: d2c_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/d2c_test
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
          cache-dependency-path: server/package-lock.json
      - run: npm ci
        working-directory: server
      - run: npx tsc --noEmit
        working-directory: server
      - run: npx vitest run
        working-directory: server

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
          cache-dependency-path: package-lock.json
      - run: npm ci
      - run: npm run build
      - run: npm run lint 2>&1 | tee /tmp/lint.txt; test "$(grep -c warning /tmp/lint.txt)" -le 16
```

- [ ] **Step 2: Verify the workflow is valid YAML and the equivalent commands pass locally**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run && npx tsc --noEmit`
Expected: all pass (this mirrors the `server` job).
Run: `npm run build && npm run lint 2>&1 | grep -c "warning"`
Expected: build succeeds, count is 16 or fewer (this mirrors the `frontend` job).
Also validate the YAML parses: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` (PyYAML is commonly available; if it isn't in this environment, visually re-check the indentation against the block above instead and say so in your report).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for server and frontend checks

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Process-level safety net and a reusable asyncHandler

**Files:**
- Create: `server/src/lib/async-handler.ts`
- Create: `server/test/lib/async-handler.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Produces: `export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler` — wraps an async route handler so a thrown/rejected error is always forwarded to `next`, usable by any future route (existing routes already handle this themselves via `next(err)` catch blocks per Task 3's own research — this is a convenience for new code, not a retrofit of existing routes, and no existing route file is modified by this task).
- Produces (in `index.ts`): `process.on("unhandledRejection", ...)` and `process.on("uncaughtException", ...)` handlers that log the error and, in production, exit the process after a short delay (`process.exitCode = 1`) so the process manager (systemd, `Restart=on-failure`) restarts it cleanly instead of the process hanging in a broken state indefinitely.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/lib/async-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { asyncHandler } from "../../src/lib/async-handler.js";

describe("asyncHandler", () => {
  it("calls the wrapped handler normally when it resolves", async () => {
    const handler = vi.fn(async (_req, res) => {
      res.json({ ok: true });
    });
    const wrapped = asyncHandler(handler as any);
    const res = { json: vi.fn() };
    const next = vi.fn();
    await wrapped({} as any, res as any, next);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a thrown error to next instead of letting it reject unhandled", async () => {
    const boom = new Error("boom");
    const handler = vi.fn(async () => {
      throw boom;
    });
    const wrapped = asyncHandler(handler as any);
    const next = vi.fn();
    await wrapped({} as any, {} as any, next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/async-handler.test.ts`
Expected: FAIL with "Cannot find module '../../src/lib/async-handler.js'".

- [ ] **Step 3: Write `server/src/lib/async-handler.ts`**

```typescript
import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async Express route handler so a rejected promise is forwarded to `next`
 * instead of becoming an unhandled rejection. Express 4 (this project's version) does
 * NOT do this automatically for async handlers — only Express 5 does. Existing routes
 * in this codebase already handle this themselves (each wraps its own body in
 * try/catch and calls next(err)); this wrapper exists so future routes can opt in
 * without having to remember that pattern by hand.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/async-handler.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Add process-level safety net to `server/src/index.ts`**

In `server/src/index.ts`, add near the top (after the imports, before `const app = express()`):

```typescript
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  if (process.env.NODE_ENV === "production") {
    process.exitCode = 1;
  }
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  if (process.env.NODE_ENV === "production") {
    process.exitCode = 1;
  }
});
```

This does not call `process.exit()` directly (which can cut off in-flight responses and log flushing) — it sets `exitCode` and lets Node finish the current tick, then exits naturally; systemd's `Restart=on-failure` (confirmed on the production server's `d2c-backend.service` unit) brings it back up within its 5-second `RestartSec`.

- [ ] **Step 6: Run the full server suite to confirm nothing else broke**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: all pass, count unchanged except for the 2 new tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/async-handler.ts server/test/lib/async-handler.test.ts server/src/index.ts
git commit -m "feat(server): add asyncHandler utility and process-level crash safety net

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Scheduler cross-process advisory lock

**Files:**
- Modify: `server/src/scheduler.ts`
- Modify: `server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `pool` from `server/src/db.js` (already imported in `scheduler.ts`).
- Produces: `runScheduledSyncs` wraps its work in a Postgres advisory lock keyed by a stable hash of the platform name, so if this process is ever run as more than one instance, only one instance's cron tick actually executes a given platform's sync — the other's `pg_try_advisory_lock` call returns `false` and it skips that tick entirely (not blocks — a skipped tick is fine since the next cron tick will try again).

- [ ] **Step 1: Write the failing test**

Add to `server/test/scheduler.test.ts` (read the existing file first to match its setup/`testPool`/connection-seeding conventions exactly):

```typescript
it("skips the sync entirely when another process already holds the platform's advisory lock", async () => {
  const id = "cccccccc-3333-3333-3333-333333333333";
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
     ($1, 'abc-fashion', 'shopify', 'connected', $2, 'abc-fashion.myshopify.com')`,
    [id, encryptToken("shpat_real_token")],
  );
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  // Simulate a second process holding the lock by acquiring it directly on a second
  // connection before calling runScheduledSyncs. testPool and the app's own `pool`
  // (imported above) resolve to the same real database in tests — see
  // test/setup.ts, which points DATABASE_URL at TEST_DATABASE_URL — so a lock taken
  // via testPool genuinely blocks runScheduledSyncs's own pool.connect() lock attempt.
  const lockClient = await testPool.connect();
  try {
    const lockKey = hashPlatformToLockKey("shopify"); // exported alongside runScheduledSyncs
    await lockClient.query("select pg_advisory_lock($1)", [lockKey]);

    await runScheduledSyncs("shopify");

    // fetch was never called — sync() never ran because the lock wasn't acquired.
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await testPool.query("select status, last_synced_at from platform_connections where id = $1", [id]);
    expect(row.rows[0].status).toBe("connected");
    expect(row.rows[0].last_synced_at).toBeNull();
  } finally {
    await lockClient.query("select pg_advisory_unlock_all()");
    lockClient.release();
  }
});
```

This matches the file's existing raw-insert convention exactly (no seeding helper exists in this file today — every other test in it inserts directly via `testPool.query`, as shown above).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/scheduler.test.ts`
Expected: FAIL — `hashPlatformToLockKey` doesn't exist yet, and even once stubbed, the sync would currently run regardless of the lock (no locking logic exists yet).

- [ ] **Step 3: Implement the lock in `server/src/scheduler.ts`**

Add near the top of the file, and wrap `runScheduledSyncs`'s body:

```typescript
import crypto from "node:crypto";

// Postgres advisory locks take a bigint key. Hash the platform name down to a stable
// 32-bit int (advisory locks accept a single bigint or two ints — one int is enough
// here, collisions across our ~5 platform names are not a practical concern).
export function hashPlatformToLockKey(platform: string): number {
  const hash = crypto.createHash("sha256").update(platform).digest();
  return hash.readInt32BE(0);
}

export async function runScheduledSyncs(platform: string) {
  const connector = connectors[platform];
  if (!connector) return;

  const lockKey = hashPlatformToLockKey(platform);
  const lockClient = await pool.connect();
  let acquired = false;
  try {
    const { rows } = await lockClient.query("select pg_try_advisory_lock($1) as acquired", [lockKey]);
    acquired = rows[0].acquired;
    if (!acquired) {
      // Another process (or an overlapping run somehow) already holds this platform's
      // lock — skip this tick entirely rather than wait; the next scheduled tick will
      // try again.
      return;
    }

    const result = await pool.query(
      "select id from platform_connections where platform = $1 and status in ('connected', 'error')",
      [platform],
    );

    for (const row of result.rows) {
      const startedAt = new Date();
      try {
        await connector.sync(row.id);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Sync failed for connection ${row.id}:`, err);
        try {
          await pool.query("update platform_connections set status = 'error' where id = $1 and status <> 'disconnected'", [row.id]);
          await pool.query(
            "insert into sync_logs (connection_id, started_at, finished_at, error) values ($1, $2, now(), $3)",
            [row.id, startedAt, errorMessage],
          );
        } catch (recoveryErr) {
          console.error(`Failed to record sync failure for connection ${row.id}:`, recoveryErr);
        }
      }
    }
  } finally {
    if (acquired) {
      await lockClient.query("select pg_advisory_unlock($1)", [lockKey]);
    }
    lockClient.release();
  }
}
```

Note: the lock is held on `lockClient` (a dedicated connection checked out from `pool` for the duration of the sync), while the actual sync queries still run on the shared `pool` as before — `pg_advisory_lock`/`unlock` are session-scoped, so the lock must be acquired and released on the SAME connection, which is why `lockClient` is separate from the ad-hoc `pool.query(...)` calls already in this function.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/scheduler.test.ts`
Expected: PASS, including all pre-existing tests in this file (the lock must not change behavior for the normal single-process case — re-read the existing tests to confirm none of them assert on connection-pool call counts in a way the new `lockClient.connect()` would break; if one does, that's a real finding, not something to paper over — report it).

- [ ] **Step 5: Run the full server suite**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/scheduler.ts server/test/scheduler.test.ts
git commit -m "fix(server): make scheduled syncs safe to run from more than one process

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Security headers and mandatory CORS in production

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/package.json` (add `helmet` dependency)
- Create: `server/test/index-security.test.ts`

**Interfaces:**
- Produces: `app.use(helmet())` added to the Express app. A startup check that throws (preventing the process from starting at all) if `NODE_ENV === "production"` and `CORS_ORIGIN` is unset or empty.

- [ ] **Step 1: Add the dependency**

Run: `cd server && npm install helmet`

- [ ] **Step 2: Write the failing test**

```typescript
// server/test/index-security.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("production CORS requirement", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws on import if NODE_ENV is production and CORS_ORIGIN is unset", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ORIGIN;
    vi.resetModules();
    await expect(import("../src/index.js")).rejects.toThrow(/CORS_ORIGIN/);
  });
});
```

Note: this test temporarily sets `NODE_ENV=production`, which also means `index.ts`'s own `if (process.env.NODE_ENV !== "test")` startup block (the `app.listen`/`startScheduler` call) would try to run for real during this one test — this must NOT happen. Step 3 fixes this by moving the CORS check to run and throw BEFORE that block, synchronously at module load, so the `import()` rejects before reaching `app.listen`. Confirm in your report that no stray server actually started listening during this test (e.g. no port-in-use errors in subsequent tests, no hanging test process).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/index-security.test.ts`
Expected: FAIL (import resolves instead of rejecting — no check exists yet).

- [ ] **Step 4: Implement in `server/src/index.ts`**

Add the helmet import and the CORS guard. The guard must run before the existing `const allowedOrigins = ...` line:

```typescript
import helmet from "helmet";
// ... existing imports ...

if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGIN?.trim()) {
  throw new Error("CORS_ORIGIN must be set when NODE_ENV=production — refusing to start with CORS open to any origin.");
}

const app = express();
app.use(helmet());
const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : {}));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/index-security.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full server suite and tsc**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: both clean. Pay particular attention to whether `helmet()`'s default headers (especially its default Content-Security-Policy or Cross-Origin-Resource-Policy) break any existing test that asserts on response headers or on cross-origin behavior — if so, that's a real finding to fix (e.g. via `helmet({ contentSecurityPolicy: false })` if this API serves no HTML itself, which it doesn't — it's a pure JSON API plus OAuth redirects), not something to silence.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/index.ts server/test/index-security.test.ts
git commit -m "feat(server): add helmet security headers and require CORS_ORIGIN in production

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Structured logging and a DB-aware health check

**Files:**
- Create: `server/src/lib/logger.ts`
- Create: `server/test/lib/logger.test.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/scheduler.ts`
- Modify: `server/package.json` (add `pino` dependency)

**Interfaces:**
- Produces: `export const logger: { info, warn, error }` from `server/src/lib/logger.ts` — a thin wrapper so call sites don't need to know whether pino or something else is behind it, and so an optional Sentry hook (triggered only if `SENTRY_DSN` is set) can be added to `.error` in one place later without touching every call site again.
- Consumes: nothing new in call sites beyond swapping `console.error(...)` → `logger.error(...)` and `console.log(...)` → `logger.info(...)` in `index.ts` and `scheduler.ts` only (the two files identified this session as using `console.*` directly for operational logging — route-level `console.error` calls inside existing routers are OUT OF SCOPE for this task; those are a separate, larger retrofit this plan does not include, since touching every router risks the exact kind of scope creep this project has specifically guarded against all session).

- [ ] **Step 1: Add the dependency**

Run: `cd server && npm install pino`

- [ ] **Step 2: Write the failing test**

```typescript
// server/test/lib/logger.test.ts
import { describe, it, expect } from "vitest";
import { logger } from "../../src/lib/logger.js";

describe("logger", () => {
  it("exposes info, warn, and error methods", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("does not throw when logging a plain message and an error object", () => {
    expect(() => logger.info("test message")).not.toThrow();
    expect(() => logger.error("test error", new Error("boom"))).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/logger.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Write `server/src/lib/logger.ts`**

```typescript
import pino from "pino";

// Pretty-print in dev/test for readability; plain JSON lines in production, which is
// what a process manager's journal (this project's systemd + journalctl) and most log
// aggregators expect.
const isProd = process.env.NODE_ENV === "production";

export const logger = pino(
  isProd
    ? { level: "info" }
    : {
        level: "debug",
        transport: { target: "pino-pretty", options: { colorize: true } },
      },
);
```

If `pino-pretty` isn't already a transitive dependency, install it too: `npm install --save-dev pino-pretty` (it's dev-only — production doesn't use the pretty transport).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run test/lib/logger.test.ts`
Expected: PASS.

- [ ] **Step 6: Swap `console.*` for `logger.*` in `index.ts` and `scheduler.ts`, and add the DB-aware health check**

In `server/src/index.ts`: replace `console.log(\`server listening on ${port}\`)` with `logger.info(\`server listening on ${port}\`)`, replace the central error-handler's `console.error(err)` with `logger.error("Unhandled route error", err)`, and replace the `unhandledRejection`/`uncaughtException` handlers' `console.error` calls (added in Task 3) with `logger.error`. Import `logger` from `./lib/logger.js`.

Replace the existing `/health` route:

```typescript
app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.status(200).json({ status: "ok" });
  } catch (err) {
    logger.error("Health check failed", err);
    res.status(503).json({ status: "error" });
  }
});
```

This requires importing `pool` from `./db.js` in `index.ts` if it isn't already imported there (check first — it may not be, since routers import it themselves).

In `server/src/scheduler.ts`: replace both `console.error` call sites with `logger.error`, importing `logger` from `./lib/logger.js`.

- [ ] **Step 7: Write a test for the DB-aware health check**

`pool` (`server/src/db.ts`) is a plain `pg.Pool` singleton constructed at import time — it can't be repointed at a bad connection string mid-test. Instead, follow the exact pattern `test/scheduler.test.ts` already uses elsewhere in this codebase for simulating a DB failure: `vi.spyOn(pool, "query")` to reject once. Add to `server/test/health.test.ts`:

```typescript
import pool from "../src/db.js";

it("returns 503 when the database is unreachable", async () => {
  const querySpy = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("connection refused"));
  try {
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error" });
  } finally {
    querySpy.mockRestore();
  }
});
```

Add `vi` to this file's existing `import { describe, it, expect } from "vitest"` line (→ `import { describe, it, expect, vi } from "vitest"`).

- [ ] **Step 8: Run the full server suite and tsc**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add server/package.json server/package-lock.json server/src/lib/logger.ts server/test/lib/logger.test.ts server/src/index.ts server/src/scheduler.ts server/test/health.test.ts
git commit -m "feat(server): structured logging and a DB-aware health check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend root `.env.example`

**Files:**
- Create: `.env.example` (repo root)

**Interfaces:**
- Produces: documentation only, no code.

- [ ] **Step 1: Write `.env.example`**

```
# Supabase project — same project as the backend's SUPABASE_URL (see server/.env.example).
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
# The anon/public key — safe to expose in the browser bundle, NOT the service role key.
VITE_SUPABASE_ANON_KEY=replace-with-supabase-anon-key

# The backend's own public base URL (same value as the backend's PUBLIC_API_URL).
VITE_API_URL=https://your-backend-domain.com
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add a root .env.example documenting the frontend's VITE_* variables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Small cleanup batch

This task batches several small, independent, same-shape fixes into one dispatch, per this project's established convention for same-shape work.

**Files:**
- Modify: `src/pages/connect-pick-accounts.tsx` (line 69, confirmed via grep before this plan was written)
- Modify: `src/pages/connect-claim.tsx` (line 69, confirmed via grep before this plan was written)
- Modify: `server/src/scheduler.ts` (add a daily expired-`pending_connections` sweep)
- Modify: `server/test/scheduler.test.ts` (test for the sweep)
- Modify: `server/test/lib/shop-domain.test.ts` (hostile-input cases)
- Delete: `graphify-out/2026-09-27/` (the whole directory — a stray, redundant snapshot folder from early in this project's history, confirmed still present)

**Interfaces:**
- No new exported interfaces — these are internal fixes.

- [ ] **Step 1: `role="alert"` on the load-error paragraphs**

In `src/pages/connect-pick-accounts.tsx` line 69 and `src/pages/connect-claim.tsx` line 69, change:
```tsx
<p className="text-[13px] text-negative">{loadError}</p>
```
to:
```tsx
<p role="alert" className="text-[13px] text-negative">{loadError}</p>
```
in both files (matching the `role="alert"` pattern already used elsewhere in each of these same files, e.g. line 108/107 respectively).

- [ ] **Step 2: Expired `pending_connections` sweep**

Read `server/test/scheduler.test.ts` first to match its conventions, then add:

```typescript
it("deletes expired pending_connections rows on the daily sweep", async () => {
  await testPool.query(
    "insert into pending_connections (id, platform, payload, expires_at) values (gen_random_uuid(), 'shopify', 'x', now() - interval '1 hour')",
  );
  const { id: freshId } = (
    await testPool.query(
      "insert into pending_connections (id, platform, payload, expires_at) values (gen_random_uuid(), 'shopify', 'x', now() + interval '1 hour') returning id",
    )
  ).rows[0];

  await sweepExpiredPendingConnections();

  const remaining = await testPool.query("select id from pending_connections");
  expect(remaining.rows.map((r) => r.id)).toEqual([freshId]);
});
```

Run it, confirm it fails (`sweepExpiredPendingConnections` doesn't exist), then add to `server/src/scheduler.ts`:

```typescript
export async function sweepExpiredPendingConnections() {
  const result = await pool.query("delete from pending_connections where expires_at < now()");
  if (result.rowCount && result.rowCount > 0) {
    logger.info(`Swept ${result.rowCount} expired pending_connections row(s)`);
  }
}
```

and register it in `startScheduler()`:

```typescript
// Pending connections expire after 30 minutes (see pending-connections.ts); sweeping
// once a day is more than frequent enough to keep the table from growing unbounded —
// expired rows are already excluded from every read path (readPending/lockPendingForUpdate
// both filter on expires_at), so this is pure cleanup, not a correctness requirement.
cron.schedule(
  "0 3 * * *",
  () => {
    sweepExpiredPendingConnections().catch((err) => logger.error("Pending-connections sweep failed:", err));
  },
  { noOverlap: true },
);
```

Run the test again, confirm it passes.

- [ ] **Step 3: Hostile-input tests for `shop-domain.test.ts`**

Read `server/src/lib/shop-domain.ts` and the existing `server/test/lib/shop-domain.test.ts` first. Add test cases covering: a domain with embedded whitespace, a domain with uppercase letters (confirm whether normalization lowercases it or rejects it — assert whichever the existing implementation actually does, don't assume), a value containing `<script>` or other HTML/URL-breaking characters, an empty string, a value that's just whitespace, a value with a trailing/leading slash, and a non-Shopify domain impersonating one (e.g. `evil.com/x.myshopify.com`). For each, assert the actual current behavior of `normalizeShopDomain` — if any of these reveals the function accepts something it clearly shouldn't (e.g. the impersonation case), stop and report it as a finding rather than writing a test that locks in a real bug; do not fix `shop-domain.ts` itself without flagging this first, since that would be a scope expansion beyond what this task's Files list covers.

- [ ] **Step 4: Remove the stray graphify snapshot folder**

```bash
git status --short graphify-out/2026-09-27 | awk '{print $1}' | sort | uniq -c
```
Confirm every file under it shows as tracked (not `??`) before removing — if anything is untracked, stop and report rather than deleting it blind.
```bash
git rm -r graphify-out/2026-09-27
```

- [ ] **Step 5: Run the full server suite, tsc, frontend build, and lint**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://ishantarora@localhost:5432/d2c_test NODE_ENV=test npx vitest run`
Run: `npm run build && npm run lint 2>&1 | grep -c "warning"`
Expected: tsc clean, all tests pass, build succeeds, lint count unchanged (16 or lower).

- [ ] **Step 6: Commit**

```bash
git add src/pages/connect-pick-accounts.tsx src/pages/connect-claim.tsx server/src/scheduler.ts server/test/scheduler.test.ts server/test/lib/shop-domain.test.ts
git rm -r graphify-out/2026-09-27
git commit -m "fix: a11y role=alert on load-error text, sweep expired pending_connections, hostile-input shop-domain tests, remove stray graphify snapshot

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Make migrations part of the deploy, not a manual afterthought

This closes `docs/production-readiness.md` section C item 3 ("database migrations are not run automatically"), which this plan's earlier tasks don't otherwise touch.

**Files:**
- Create: `server/docker-entrypoint.sh`
- Modify: `server/Dockerfile` (from Task 1 — use the entrypoint script)
- Create: `docs/DEPLOY.md`

**Interfaces:**
- Produces: for the containerized path (Task 1's Dockerfile), migrations now run automatically before the server starts. For the live, non-containerized deploy (systemd on the production VPS, unaffected by Docker), `docs/DEPLOY.md` makes the migration step an explicit, un-skippable line in the documented process instead of something only this session's own memory knows about.

- [ ] **Step 1: Write `server/docker-entrypoint.sh`**

```bash
#!/bin/sh
set -e
echo "Running database migrations..."
npm run migrate up
echo "Starting server..."
exec node dist/index.js
```

- [ ] **Step 2: Update `server/Dockerfile`'s final stage to use it**

In the Dockerfile written in Task 1, after `COPY --from=build /app/dist ./dist` and `COPY --from=build /app/migrations ./migrations`, add:

```dockerfile
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
```

and change the final line from `CMD ["node", "dist/index.js"]` to:

```dockerfile
ENTRYPOINT ["./docker-entrypoint.sh"]
```

This also requires `node-pg-migrate` and the `migrate` npm script to be available in the final (production) image — check whether Task 1's `RUN npm ci --omit=dev` excludes `node-pg-migrate` (it's a devDependency in `server/package.json` per this plan's Global Constraints research). If it does, change that line to `RUN npm ci` (keep devDependencies) for this final stage, since the entrypoint needs `node-pg-migrate` at runtime — note this trade-off (slightly larger image) in your report rather than silently picking one option.

- [ ] **Step 3: Write `docs/DEPLOY.md`**

```markdown
# Deploying this project

This is the exact sequence used to deploy to `d2c.probild.in` (systemd + nginx, no containers on that host today). Follow it in order — skipping the migration step is the most common way to end up with a server running new code against an old schema.

1. SSH to the host as the `d2c` user (not root) for everything except the migration step and service restart, which need `/etc/d2c.env` (root-only readable) and `systemctl` (root-only).
2. `cd /var/www/d2c/app && git pull origin main`
3. `npm install && npm run build` (repo root — builds the frontend into `dist/`, served directly by nginx)
4. `cd server && npm install && npm run build` (builds the backend into `server/dist/`)
5. **Migrations — do not skip:** as root, `set -a; source /etc/d2c.env; set +a; cd /var/www/d2c/app/server && npm run migrate up`. Run `npm run migrate up -- --dry-run` first if you want to review the SQL before it runs for real.
6. As root: `systemctl restart d2c-backend`
7. Verify: `curl https://d2c.probild.in/health` should return `{"status":"ok"}` (now DB-aware as of this plan's Task 6 — a 503 here means something in steps 2-6 went wrong, not that the service merely failed to start).

If this project is ever moved to a container-based host, the same five steps collapse into one `docker build && docker run` — `server/docker-entrypoint.sh` (added in this plan) runs the migration step automatically before starting the server.
```

- [ ] **Step 4: Verify**

Confirm the Dockerfile still builds (same verification as Task 1 Step 3 — Docker if available, otherwise the equivalent manual commands). `docs/DEPLOY.md` is documentation only — no automated verification, just re-read it once for accuracy against what Tasks 1-8 actually produced.

- [ ] **Step 5: Commit**

```bash
git add server/docker-entrypoint.sh server/Dockerfile docs/DEPLOY.md
git commit -m "feat(server): run migrations automatically before the server starts, document the manual deploy steps

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
