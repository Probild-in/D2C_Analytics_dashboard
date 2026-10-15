# Real Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's fake, scripted "Notifications" bell menu with real notifications generated from real signals (task events, daily RTO/sales-dip/ad-spend-anomaly/blended-ROAS checks) and delivered live to the browser.

**Architecture:** A new `notifications` table (+ per-staff `notification_reads`) is written to from two places — synchronously inside the existing task-create/complete routes, and once daily from a new cron job that re-checks each client's RTO%, sales, ad spend, and blended ROAS against fixed thresholds using yesterday's complete data. Every insert also publishes to an in-process `EventEmitter`, which a new Server-Sent-Events route uses to push new notifications live to any open dashboard.

**Tech Stack:** Node/Express/TypeScript (`server/`), Postgres, `node-cron` (already a dependency), React/Vite (`src/`) — no new npm dependencies.

**Spec:** docs/superpowers/specs/2026-10-16-real-notifications-design.md

## Global Constraints

- No new npm dependencies, front or back — SSE via plain `fetch` + `ReadableStream` on the frontend, plain `res.write()` on the backend; no socket.io/ws library.
- Every new route reuses the existing `isStaffMember`/`getAccessibleClientIds`/`assertClientAccess` access-scoping pattern (`server/src/lib/access.ts`) — a self-serve owner only ever sees their own client's notifications, exactly like every other route touched in the prior SaaS signup plan's final review.
- All day-boundary logic uses this app's `Asia/Kolkata` business-timezone convention (`server/src/lib/sql-dates.ts`'s `BUSINESS_TIMEZONE`/`IST_DAY_START`), never a bare UTC date — this project has a documented history of day-boundary bugs from skipping this.
- The daily check job runs once per day (not every 15 minutes) against yesterday's *complete* data, never partial same-day data — comparing a partial day against a complete prior period produces false positives (see spec's "Architecture" section for the concrete reasoning).
- Blended ROAS alerting must use `net sales / ad spend` (matching `src/hooks/use-period-data.ts`'s `blendedRoas` — `sum(shopify_orders.amount where status <> 'Cancelled') / (meta spend + google spend)`), not the per-campaign `revenue / spend` figure `campaigns.ts` reports — these are different metrics in this codebase and "Blended ROAS" means the former everywhere else it appears.
- "Campaign feedback" and "system" notification kinds are explicitly out of scope — do not add them; no task in this plan should reference them.

## Review Focus

- A client with zero ad spend (not yet connected to Meta/Google) must not trigger a false "ROAS below target" or "ad spend anomaly" alert from dividing by zero — both checks must skip entirely when yesterday's ad spend is `0`, not alert "0x ROAS". Test in Task 5.
- A client with zero orders on the comparison day one week ago must not trigger a false "sales dip" from comparing against nothing — skip when last week's comparison-day order count is `0`. Test in Task 5.
- A client with no shipments/courier connected yet must not crash the RTO check — it must reuse the existing `has_shipments`-guarded CTE from `rto-status.ts` verbatim, not re-derive the logic. Test in Task 5.
- The de-duplication window must prevent the same client+kind from alerting twice within one run cycle, while still re-alerting on a *later* day if the condition persists — a client stuck in `critical` RTO for 3 days running must get 3 separate notifications (one per day), not 1 or 0. Test in Task 5.
- A self-serve owner must never receive another tenant's notifications over the SSE stream, even transiently — the stream's per-connection access check happens once at connect time (per the spec's documented, deliberate trade-off), so this must specifically be tested as "a stream opened for client A's notifications never receives an event emitted for client B", not just checked via the REST list endpoint. Test in Task 3.

---

### Task 1: Migration — `notifications` and `notification_reads` tables

**Files:**
- Create: `server/migrations/016_notifications.sql`
- Test: `server/test/migration-016.test.ts`

**Interfaces:**
- Produces: `notifications(id uuid pk, client_id text, kind text, title text, description text, created_at timestamptz)`, `notification_reads(notification_id uuid, team_member_id uuid, read_at timestamptz, pk(notification_id, team_member_id))`.

- [ ] **Step 1: Write the migration**

```sql
-- server/migrations/016_notifications.sql
-- Real notifications, replacing the dashboard's previously-fake, hardcoded bell menu
-- (src/data/mock.ts's getNotifications()). See
-- docs/superpowers/specs/2026-10-16-real-notifications-design.md for the full design.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  kind text not null check (kind in ('rto', 'sales', 'ads', 'roas', 'task')),
  title text not null,
  description text not null,
  created_at timestamptz not null default now()
);

create index notifications_client_id_created_at_idx on notifications (client_id, created_at desc);

-- Per-staff-member read state — a notification is unread for a given team member
-- until they have a row here. Different team members reading the same client's
-- notifications must not share read state.
create table notification_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  team_member_id uuid not null references team_members(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, team_member_id)
);
```

- [ ] **Step 2: Write the test**

```typescript
// server/test/migration-016.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

describe("migration 016: notifications", () => {
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

  it("accepts a valid notification row for each allowed kind", async () => {
    for (const kind of ["rto", "sales", "ads", "roas", "task"]) {
      const res = await testPool.query(
        `insert into notifications (client_id, kind, title, description) values ($1, $2, 'Test', 'Test description') returning id`,
        ["abc-fashion", kind],
      );
      expect(res.rowCount).toBe(1);
    }
  });

  it("rejects an unrecognized kind", async () => {
    await expect(
      testPool.query(`insert into notifications (client_id, kind, title, description) values ($1, 'campaign', 'x', 'x')`, [
        "abc-fashion",
      ]),
    ).rejects.toThrow();
  });

  it("deletes notification_reads when the notification is deleted (cascade)", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ($1, 'task', 'x', 'x') returning id`,
      ["abc-fashion"],
    );
    await testPool.query(`insert into notification_reads (notification_id, team_member_id) values ($1, $2)`, [
      notif.rows[0].id,
      "11111111-1111-1111-1111-111111111111",
    ]);
    await testPool.query(`delete from notifications where id = $1`, [notif.rows[0].id]);
    const reads = await testPool.query(`select * from notification_reads`);
    expect(reads.rowCount).toBe(0);
  });

  it("allows the same team member to read-mark two different notifications, but not the same notification twice", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ($1, 'task', 'x', 'x') returning id`,
      ["abc-fashion"],
    );
    await testPool.query(`insert into notification_reads (notification_id, team_member_id) values ($1, $2)`, [
      notif.rows[0].id,
      "11111111-1111-1111-1111-111111111111",
    ]);
    await expect(
      testPool.query(`insert into notification_reads (notification_id, team_member_id) values ($1, $2)`, [
        notif.rows[0].id,
        "11111111-1111-1111-1111-111111111111",
      ]),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/migration-016.test.ts`
Expected: FAIL — relation "notifications" does not exist

- [ ] **Step 4: Run test to verify it passes**

Run the same command. Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/migrations/016_notifications.sql server/test/migration-016.test.ts
git commit -m "feat(server): add notifications + notification_reads tables"
```

---

### Task 2: `notification-bus.ts` — in-process pub/sub for live push

**Files:**
- Create: `server/src/lib/notification-bus.ts`
- Test: `server/test/lib/notification-bus.test.ts`

**Interfaces:**
- Produces: `publishNotification(n: PublishedNotification): void`, `subscribeToNotifications(listener: (n: PublishedNotification) => void): () => void` (returns an unsubscribe function), `interface PublishedNotification { id: string; clientId: string; clientName: string; kind: "rto" | "sales" | "ads" | "roas" | "task"; title: string; description: string; createdAt: string }`. `clientName` travels with every live-pushed event so the frontend never has to look it up separately — it must match exactly what `GET /api/notifications` (Task 3) returns for the same row, since both paths render into the same list.
- Consumed by: Task 3's SSE route (subscribes), Task 4's task routes and Task 6's scheduler job (publish after each insert).

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/lib/notification-bus.test.ts
import { describe, it, expect, vi } from "vitest";
import { publishNotification, subscribeToNotifications } from "../../src/lib/notification-bus.js";

describe("notification-bus", () => {
  it("delivers a published notification to a subscriber", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotifications(listener);
    const notif = { id: "n1", clientId: "abc-fashion", clientName: "ABC Fashion", kind: "task" as const, title: "t", description: "d", createdAt: "2026-10-16T00:00:00.000Z" };
    publishNotification(notif);
    expect(listener).toHaveBeenCalledWith(notif);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotifications(listener);
    unsubscribe();
    publishNotification({ id: "n2", clientId: "abc-fashion", clientName: "ABC Fashion", kind: "task", title: "t", description: "d", createdAt: "2026-10-16T00:00:00.000Z" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to every active subscriber, not just the first", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeToNotifications(a);
    const unsubB = subscribeToNotifications(b);
    const notif = { id: "n3", clientId: "abc-fashion", clientName: "ABC Fashion", kind: "task" as const, title: "t", description: "d", createdAt: "2026-10-16T00:00:00.000Z" };
    publishNotification(notif);
    expect(a).toHaveBeenCalledWith(notif);
    expect(b).toHaveBeenCalledWith(notif);
    unsubA();
    unsubB();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/lib/notification-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/lib/notification-bus.ts
import { EventEmitter } from "node:events";

export interface PublishedNotification {
  id: string;
  clientId: string;
  clientName: string;
  kind: "rto" | "sales" | "ads" | "roas" | "task";
  title: string;
  description: string;
  createdAt: string;
}

// A single in-process event bus for live notification delivery (see Task 3's SSE route).
// This app runs as one systemd process on one host (docs/DEPLOY.md) — if that ever
// changes to multiple processes/hosts, this in-memory bus stops being sufficient and
// needs a real pub/sub (e.g. Postgres LISTEN/NOTIFY or Redis) — not a concern today.
const EVENT_NAME = "notification";
const emitter = new EventEmitter();
// Default of 10 would log an "EventEmitter memory leak" warning once more than 10
// dashboard sessions have an SSE connection open at the same time — raise it generously
// rather than silence a real signal if this app ever does leak listeners.
emitter.setMaxListeners(200);

export function publishNotification(notification: PublishedNotification): void {
  emitter.emit(EVENT_NAME, notification);
}

export function subscribeToNotifications(listener: (notification: PublishedNotification) => void): () => void {
  emitter.on(EVENT_NAME, listener);
  return () => emitter.off(EVENT_NAME, listener);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/lib/notification-bus.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/notification-bus.ts server/test/lib/notification-bus.test.ts
git commit -m "feat(server): add an in-process notification pub/sub bus"
```

---

### Task 3: Notification routes — list, mark-read, live stream

**Files:**
- Create: `server/src/routes/notifications.ts`
- Modify: `server/src/index.ts` (mount at `/api/notifications`)
- Test: `server/test/routes/notifications.test.ts`

**Interfaces:**
- Consumes: `getAccessibleClientIds`, `isStaffMember` (`server/src/lib/access.ts`), `subscribeToNotifications`/`publishNotification`/`PublishedNotification` (Task 2, `server/src/lib/notification-bus.js`).
- Produces: `GET /api/notifications` (list, scoped, with `read` computed per caller), `POST /api/notifications/:id/read` (idempotent), `GET /api/notifications/stream` (SSE). Task 4 and Task 6 both insert directly into the `notifications` table and call `publishNotification` themselves — this router does not own writes other than the read-marking table.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/routes/notifications.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

const STAFF_ID = "11111111-1111-1111-1111-111111111111";
const SELF_SERVE_ID = "22222222-2222-2222-2222-222222222222";

async function seed() {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A'),
     ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty & Cosmetics', 'bg-rose-500', 'X')`,
  );
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access, account_type) values
     ($1, 'Riya Kapoor', 'riya@agency.com', 'owner', true, 'staff'),
     ($2, 'Amit Rao', 'amit@selfserve.com', 'owner', false, 'self_serve_owner')`,
    [STAFF_ID, SELF_SERVE_ID],
  );
  await testPool.query(`insert into team_member_clients (team_member_id, client_id) values ($1, 'abc-fashion')`, [SELF_SERVE_ID]);
}

function tokenFor(id: string, email: string) {
  return signTestJwt({ sub: id, email });
}

describe("GET /api/notifications", () => {
  beforeEach(seed);

  it("requires authentication", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  it("staff with all_client_access sees notifications across every client, most recent first", async () => {
    await testPool.query(
      `insert into notifications (client_id, kind, title, description, created_at) values
       ('abc-fashion', 'task', 'Older', 'd', now() - interval '1 hour'),
       ('xyz-cosmetics', 'rto', 'Newer', 'd', now())`,
    );
    const res = await request(app).get("/api/notifications").set("Authorization", `Bearer ${tokenFor(STAFF_ID, "riya@agency.com")}`);
    expect(res.status).toBe(200);
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(["Newer", "Older"]);
    expect(res.body[0]).toMatchObject({ clientId: "xyz-cosmetics", clientName: "XYZ Cosmetics", kind: "rto", read: false });
  });

  it("a self-serve owner sees only their own client's notifications", async () => {
    await testPool.query(
      `insert into notifications (client_id, kind, title, description) values
       ('abc-fashion', 'task', 'Mine', 'd'),
       ('xyz-cosmetics', 'rto', 'Not mine', 'd')`,
    );
    const res = await request(app).get("/api/notifications").set("Authorization", `Bearer ${tokenFor(SELF_SERVE_ID, "amit@selfserve.com")}`);
    expect(res.status).toBe(200);
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(["Mine"]);
  });

  it("marks a notification read for the caller once POST /:id/read is called, without affecting other callers", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ('abc-fashion', 'task', 'x', 'd') returning id`,
    );
    const id = notif.rows[0].id;
    const staffToken = tokenFor(STAFF_ID, "riya@agency.com");
    const selfServeToken = tokenFor(SELF_SERVE_ID, "amit@selfserve.com");

    const markRes = await request(app).post(`/api/notifications/${id}/read`).set("Authorization", `Bearer ${staffToken}`);
    expect(markRes.status).toBe(200);

    const staffList = await request(app).get("/api/notifications").set("Authorization", `Bearer ${staffToken}`);
    expect(staffList.body.find((n: { id: string }) => n.id === id).read).toBe(true);

    const selfServeList = await request(app).get("/api/notifications").set("Authorization", `Bearer ${selfServeToken}`);
    expect(selfServeList.body.find((n: { id: string }) => n.id === id).read).toBe(false);
  });

  it("marking the same notification read twice does not error", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ('abc-fashion', 'task', 'x', 'd') returning id`,
    );
    const token = tokenFor(STAFF_ID, "riya@agency.com");
    await request(app).post(`/api/notifications/${notif.rows[0].id}/read`).set("Authorization", `Bearer ${token}`);
    const second = await request(app).post(`/api/notifications/${notif.rows[0].id}/read`).set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);
  });

  it("404s marking read a notification for a client the caller can't access", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ('xyz-cosmetics', 'task', 'x', 'd') returning id`,
    );
    const res = await request(app)
      .post(`/api/notifications/${notif.rows[0].id}/read`)
      .set("Authorization", `Bearer ${tokenFor(SELF_SERVE_ID, "amit@selfserve.com")}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/notifications/stream", () => {
  beforeEach(seed);

  it("delivers a notification published for an accessible client", async () => {
    // The real insert-then-publish happens inside Task 4's task routes and Task 6's
    // scheduler job — this task owns only the stream's delivery/filtering behavior, so
    // it calls publishNotification directly rather than going through either of those.
    const { publishNotification } = await import("../../src/lib/notification-bus.js");
    const token = tokenFor(SELF_SERVE_ID, "amit@selfserve.com");
    const received: string[] = [];
    const streamPromise = request(app)
      .get("/api/notifications/stream")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk) => {
          received.push(chunk.toString());
          if (received.join("").includes("Mine, for real")) {
            res.destroy();
            cb(null, received.join(""));
          }
        });
      });
    await new Promise((r) => setTimeout(r, 50));
    publishNotification({
      id: "n-y",
      clientId: "abc-fashion",
      clientName: "ABC Fashion",
      kind: "task",
      title: "Mine, for real",
      description: "d",
      createdAt: new Date().toISOString(),
    });
    const res = await streamPromise;
    expect(res.text).toContain("Mine, for real");
  });

  it("never delivers a notification published for a client the caller can't access", async () => {
    const { publishNotification } = await import("../../src/lib/notification-bus.js");
    const token = tokenFor(SELF_SERVE_ID, "amit@selfserve.com");
    const received: string[] = [];
    const streamPromise = request(app)
      .get("/api/notifications/stream")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk) => received.push(chunk.toString()));
        setTimeout(() => {
          res.destroy();
          cb(null, received.join(""));
        }, 200);
      });
    await new Promise((r) => setTimeout(r, 50));
    publishNotification({ id: "n-x", clientId: "xyz-cosmetics", clientName: "XYZ Cosmetics", kind: "rto", title: "Not mine", description: "d", createdAt: new Date().toISOString() });
    const res = await streamPromise;
    expect(res.text).not.toContain("Not mine");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/notifications.test.ts`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the route**

```typescript
// server/src/routes/notifications.ts
import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds, isStaffMember } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { subscribeToNotifications, type PublishedNotification } from "../lib/notification-bus.js";

const router = Router();

interface NotificationRow {
  id: string;
  client_id: string;
  client_name: string;
  kind: string;
  title: string;
  description: string;
  created_at: Date;
  read: boolean;
}

function mapRow(r: NotificationRow) {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    kind: r.kind,
    title: r.title,
    description: r.description,
    createdAt: r.created_at.toISOString(),
    read: r.read,
  };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
    if (accessible !== "all" && accessible.length === 0) {
      res.json([]);
      return;
    }
    const result = await pool.query<NotificationRow>(
      `select n.id, n.client_id, c.name as client_name, n.kind, n.title, n.description, n.created_at,
         (nr.notification_id is not null) as read
       from notifications n
       join clients c on c.id = n.client_id
       left join notification_reads nr on nr.notification_id = n.id and nr.team_member_id = $1
       where $2::text[] is null or n.client_id = any($2::text[])
       order by n.created_at desc
       limit 50`,
      [req.auth!.userId, accessible === "all" ? null : accessible],
    );
    res.json(result.rows.map(mapRow));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const notifId = req.params.id;
    const notif = await pool.query<{ client_id: string }>("select client_id from notifications where id = $1", [notifId]);
    if (notif.rowCount === 0) {
      throw new HttpError(404, "not_found", "Notification not found");
    }
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
    if (accessible !== "all" && !accessible.includes(notif.rows[0].client_id)) {
      throw new HttpError(404, "not_found", "Notification not found");
    }
    await pool.query(
      `insert into notification_reads (notification_id, team_member_id) values ($1, $2) on conflict do nothing`,
      [notifId, req.auth!.userId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/stream", requireAuth, async (req, res, next) => {
  try {
    // Access is checked once, at connect time — a deliberate trade-off documented in
    // the spec: a team member's scope changing mid-connection is a known, acceptable
    // staleness window (the same class as every other access check in this app, none
    // of which re-verify mid-request either), not a gap introduced by this feature.
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which would silently defeat SSE's
      // "live" delivery in production (docs/DEPLOY.md: this app sits behind nginx) —
      // this header tells nginx to pass bytes through immediately instead.
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");

    const unsubscribe = subscribeToNotifications((notification: PublishedNotification) => {
      if (accessible !== "all" && !accessible.includes(notification.clientId)) return;
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    });

    // Keeps the connection alive through any intermediary (nginx, a load balancer) that
    // closes idle connections, and lets the browser detect a dead connection and
    // reconnect sooner than its own default timeout would.
    const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router**

In `server/src/index.ts`, add the import and mount alongside `teamMembersRouter`:
```typescript
import notificationsRouter from "./routes/notifications.js";
...
app.use("/api/notifications", notificationsRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/notifications.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/notifications.ts server/src/index.ts server/test/routes/notifications.test.ts
git commit -m "feat(server): add notification list, mark-read, and live SSE stream routes"
```

---

### Task 4: Real task-assigned / task-completed notifications

**Files:**
- Modify: `server/src/routes/tasks.ts`
- Test: `server/test/routes/tasks.test.ts` (extend existing file — read it first)

**Interfaces:**
- Consumes: `publishNotification` (Task 2).
- Produces: a real `notifications` row (and live push) on every task create and every transition to `'Completed'`.

- [ ] **Step 1: Read the existing test file first**

Read `server/test/routes/tasks.test.ts` in full to match its existing seed data and style before adding to it.

- [ ] **Step 2: Write the failing tests**

Add to `server/test/routes/tasks.test.ts` (adjust the exact client/team-member ids/tokens to match whatever the file's existing `beforeEach` already seeds — do not re-seed duplicate rows):

```typescript
describe("task notifications", () => {
  it("creating a task inserts a real notification naming the assignee, not a generic placeholder", async () => {
    const res = await request(app)
      .post(`/api/clients/${CLIENT_ID}/tasks`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ title: "Review creative", assigneeId: ASSIGNEE_ID, priority: "Medium", dueDate: "2026-11-01" });
    expect(res.status).toBe(201);

    const notifs = await testPool.query("select kind, title, description, client_id from notifications where client_id = $1", [CLIENT_ID]);
    expect(notifs.rows).toContainEqual(
      expect.objectContaining({
        kind: "task",
        title: `Task assigned to ${ASSIGNEE_NAME}`,
        description: `${ASSIGNEE_NAME} was assigned: "Review creative".`,
      }),
    );
  });

  it("marking a task Completed inserts a real notification; other status transitions do not", async () => {
    const created = await request(app)
      .post(`/api/clients/${CLIENT_ID}/tasks`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ title: "Approve copy", assigneeId: ASSIGNEE_ID, priority: "Low", dueDate: "2026-11-01" });
    const taskId = created.body.id;

    await request(app).patch(`/api/clients/${CLIENT_ID}/tasks/${taskId}`).set("Authorization", `Bearer ${TOKEN}`).send({ status: "In Progress" });
    const afterInProgress = await testPool.query("select count(*)::int as count from notifications where kind = 'task' and title = 'Task completed'");
    expect(afterInProgress.rows[0].count).toBe(0);

    await request(app).patch(`/api/clients/${CLIENT_ID}/tasks/${taskId}`).set("Authorization", `Bearer ${TOKEN}`).send({ status: "Completed" });
    const afterCompleted = await testPool.query(
      "select description from notifications where kind = 'task' and title = 'Task completed' and client_id = $1",
      [CLIENT_ID],
    );
    expect(afterCompleted.rows).toContainEqual({ description: `"Approve copy" was marked completed.` });
  });
});
```

(Fill in `CLIENT_ID`/`TOKEN`/`ASSIGNEE_ID`/`ASSIGNEE_NAME` from the file's existing seed data at the top — every other test in this file already uses these, follow that exact pattern rather than introducing new constants.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/tasks.test.ts`
Expected: FAIL — no notifications row inserted

- [ ] **Step 4: Wire the inserts**

In `server/src/routes/tasks.ts`, add the import:
```typescript
import { publishNotification } from "../lib/notification-bus.js";
```

In the `POST /` handler, after the existing `insert into crm_tasks ...` and before `res.status(201).json(...)`, add (the client's name travels with the live-pushed event so the frontend never looks it up separately — see Task 2's `PublishedNotification.clientName`):
```typescript
    const clientName = (await pool.query<{ name: string }>("select name from clients where id = $1", [clientId])).rows[0].name;
    const notif = await pool.query(
      `insert into notifications (client_id, kind, title, description) values ($1, 'task', $2, $3) returning id, created_at`,
      [clientId, `Task assigned to ${assignee.rows[0].name}`, `${assignee.rows[0].name} was assigned: "${title.trim()}".`],
    );
    publishNotification({
      id: notif.rows[0].id,
      clientId,
      clientName,
      kind: "task",
      title: `Task assigned to ${assignee.rows[0].name}`,
      description: `${assignee.rows[0].name} was assigned: "${title.trim()}".`,
      createdAt: notif.rows[0].created_at.toISOString(),
    });
```

In the `PATCH /:taskId` handler, after the existing `update crm_tasks set status = ...` succeeds and only when the new status is `'Completed'` (check `status === "Completed"`, right after the `updated.rowCount === 0` guard, before fetching `assignee`), add:
```typescript
    if (status === "Completed") {
      const clientName = (await pool.query<{ name: string }>("select name from clients where id = $1", [clientId])).rows[0].name;
      const notif = await pool.query(
        `insert into notifications (client_id, kind, title, description) values ($1, 'task', 'Task completed', $2) returning id, created_at`,
        [clientId, `"${updated.rows[0].title}" was marked completed.`],
      );
      publishNotification({
        id: notif.rows[0].id,
        clientId,
        clientName,
        kind: "task",
        title: "Task completed",
        description: `"${updated.rows[0].title}" was marked completed.`,
        createdAt: notif.rows[0].created_at.toISOString(),
      });
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/routes/tasks.test.ts`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/tasks.ts server/test/routes/tasks.test.ts
git commit -m "feat(server): generate real notifications on task assignment and completion"
```

---

### Task 5: `notification-checks.ts` — RTO / sales-dip / ad-spend-anomaly / blended-ROAS daily checks

**Files:**
- Create: `server/src/lib/notification-checks.ts`
- Test: `server/test/lib/notification-checks.test.ts`

**Interfaces:**
- Consumes: `ORDER_RTO_CTES_SINGLE_CLIENT` (`server/src/lib/rto-status.ts`), `publishNotification` (Task 2).
- Produces: `getIstDayBoundaries(daysAgo: number): { start: Date; end: Date }`, `runDailyNotificationChecks(pool: pg.Pool): Promise<void>` — called by Task 6's scheduler registration.

- [ ] **Step 1: Write the failing tests**

```typescript
// server/test/lib/notification-checks.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { getIstDayBoundaries, runDailyNotificationChecks } from "../../src/lib/notification-checks.js";

describe("getIstDayBoundaries", () => {
  it("returns a 24-hour range, with daysAgo=1 ending at daysAgo=0's start", () => {
    const yesterday = getIstDayBoundaries(1);
    const today = getIstDayBoundaries(0);
    expect(yesterday.end.getTime()).toBe(today.start.getTime());
    expect(today.start.getTime() - yesterday.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("runDailyNotificationChecks", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status) values
       ('33333333-3333-3333-3333-333333333333', 'abc-fashion', 'shopify', 'connected')`,
    );
  });

  it("alerts RTO when yesterday's RTO rate is in the critical band (>=15%)", async () => {
    const { start } = getIstDayBoundaries(1);
    // 10 orders yesterday, 2 RTO'd (via shopify's own status, since no courier connected)
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000), i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind, title from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
  });

  it("does not alert RTO when yesterday's rate is healthy (<8%)", async () => {
    const { start } = getIstDayBoundaries(1);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000)],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(0);
  });

  it("does not crash and does not alert for a client with zero orders yesterday (RTO, sales, ads, roas all skip cleanly)", async () => {
    await expect(runDailyNotificationChecks(testPool)).resolves.not.toThrow();
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion'");
    expect(notifs.rowCount).toBe(0);
  });

  it("alerts a sales dip of >=20% vs the same weekday one week before yesterday", async () => {
    const yesterday = getIstDayBoundaries(1);
    const weekBefore = getIstDayBoundaries(8);
    // 10 orders the comparison day, 5 yesterday => 50% dip
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `last-week-${i}`, new Date(weekBefore.start.getTime() + i * 60000)],
      );
    }
    for (let i = 0; i < 5; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `yesterday-${i}`, new Date(yesterday.start.getTime() + i * 60000)],
      );
    }
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select kind from notifications where client_id = 'abc-fashion' and kind = 'sales'");
    expect(notifs.rowCount).toBe(1);
  });

  it("does not alert a sales dip when last week's comparison day had zero orders", async () => {
    const yesterday = getIstDayBoundaries(1);
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ($1, $2, $3, 'Test', $4, 1000, 'Delivered', 'COD')`,
      ["abc-fashion", "33333333-3333-3333-3333-333333333333", "yesterday-1", new Date(yesterday.start.getTime())],
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'sales'");
    expect(notifs.rowCount).toBe(0);
  });

  it("does not insert a second notification of the same kind within the de-dup window", async () => {
    const { start } = getIstDayBoundaries(1);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000), i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(1);
  });

  it("re-alerts on a later day if the condition still holds, once the de-dup window has passed", async () => {
    const { start } = getIstDayBoundaries(1);
    for (let i = 0; i < 10; i++) {
      await testPool.query(
        `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
         ($1, $2, $3, 'Test', $4, 1000, $5, 'COD')`,
        ["abc-fashion", "33333333-3333-3333-3333-333333333333", `order-${i}`, new Date(start.getTime() + i * 60000), i < 2 ? "RTO Initiated" : "Delivered"],
      );
    }
    await runDailyNotificationChecks(testPool);
    // Simulate the first alert having happened outside the 20-hour de-dup window (e.g.
    // yesterday's run), so a client stuck in `critical` for multiple days running gets a
    // fresh notification each day, not just once ever.
    await testPool.query(
      "update notifications set created_at = now() - interval '25 hours' where client_id = 'abc-fashion' and kind = 'rto'",
    );
    await runDailyNotificationChecks(testPool);
    const notifs = await testPool.query("select * from notifications where client_id = 'abc-fashion' and kind = 'rto'");
    expect(notifs.rowCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/notification-checks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/lib/notification-checks.ts
import type pg from "pg";
import { ORDER_RTO_CTES_SINGLE_CLIENT } from "./rto-status.js";
import { publishNotification } from "./notification-bus.js";
import { logger } from "./logger.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Returns the [start, end) instant range (as real UTC Date objects, safe to bind as
// timestamptz query params) for the IST calendar day `daysAgo` days before today.
// daysAgo=0 is today, daysAgo=1 is yesterday, daysAgo=8 is the same weekday one week
// before yesterday. IST has no DST, so a fixed +5:30 offset is exact, unlike most
// timezones — see server/src/lib/sql-dates.ts for the equivalent SQL-side convention
// this mirrors.
export function getIstDayBoundaries(daysAgo: number): { start: Date; end: Date } {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnightTodayUtcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS;
  const start = new Date(istMidnightTodayUtcMs - daysAgo * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const DEDUP_WINDOW = "interval '20 hours'";

async function alreadyAlertedRecently(pool: pg.Pool, clientId: string, kind: string): Promise<boolean> {
  const result = await pool.query(
    `select 1 from notifications where client_id = $1 and kind = $2 and created_at > now() - ${DEDUP_WINDOW}`,
    [clientId, kind],
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertAndPublish(
  pool: pg.Pool,
  clientId: string,
  clientName: string,
  kind: "rto" | "sales" | "ads" | "roas",
  title: string,
  description: string,
) {
  const inserted = await pool.query(
    `insert into notifications (client_id, kind, title, description) values ($1, $2, $3, $4) returning id, created_at`,
    [clientId, kind, title, description],
  );
  publishNotification({
    id: inserted.rows[0].id,
    clientId,
    clientName,
    kind,
    title,
    description,
    createdAt: inserted.rows[0].created_at.toISOString(),
  });
}

async function checkRto(pool: pg.Pool, clientId: string, clientName: string, yesterday: { start: Date; end: Date }) {
  if (await alreadyAlertedRecently(pool, clientId, "rto")) return;
  const result = await pool.query<{ total: string; rto: string }>(
    `with ${ORDER_RTO_CTES_SINGLE_CLIENT}
     select count(*) as total, count(*) filter (where is_rto) as rto
     from order_rto
     join shopify_orders o on o.id = order_rto.order_id
     where o.order_date >= $2 and o.order_date < $3`,
    [clientId, yesterday.start, yesterday.end],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const rto = Number(result.rows[0]?.rto ?? 0);
  if (total === 0) return;
  const rtoPercent = (rto / total) * 100;
  if (rtoPercent >= 15) {
    await insertAndPublish(pool, clientId, clientName, "rto", "RTO alert", `RTO rate hit ${rtoPercent.toFixed(1)}% yesterday — critical threshold is 15%.`);
  } else if (rtoPercent >= 8) {
    await insertAndPublish(pool, clientId, clientName, "rto", "RTO alert", `RTO rate hit ${rtoPercent.toFixed(1)}% yesterday — attention threshold is 8%.`);
  }
}

async function checkSalesDip(
  pool: pg.Pool,
  clientId: string,
  clientName: string,
  yesterday: { start: Date; end: Date },
  weekBefore: { start: Date; end: Date },
) {
  if (await alreadyAlertedRecently(pool, clientId, "sales")) return;
  const [y, w] = await Promise.all([
    pool.query<{ count: string }>("select count(*) as count from shopify_orders where client_id = $1 and order_date >= $2 and order_date < $3", [
      clientId,
      yesterday.start,
      yesterday.end,
    ]),
    pool.query<{ count: string }>("select count(*) as count from shopify_orders where client_id = $1 and order_date >= $2 and order_date < $3", [
      clientId,
      weekBefore.start,
      weekBefore.end,
    ]),
  ]);
  const yesterdayCount = Number(y.rows[0].count);
  const weekBeforeCount = Number(w.rows[0].count);
  if (weekBeforeCount === 0) return; // nothing to meaningfully compare against
  const dipPercent = ((weekBeforeCount - yesterdayCount) / weekBeforeCount) * 100;
  if (dipPercent >= 20) {
    await insertAndPublish(
      pool,
      clientId,
      clientName,
      "sales",
      "Sales dip detected",
      `Orders dropped ${dipPercent.toFixed(0)}% yesterday compared to the same day last week.`,
    );
  }
}

async function getAdSpend(pool: pg.Pool, clientId: string, range: { start: Date; end: Date }): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `select coalesce(
       (select sum(spend) from meta_campaign_metrics where client_id = $1 and metric_date >= $2::date and metric_date < $3::date), 0
     ) + coalesce(
       (select sum(spend) from google_campaign_metrics where client_id = $1 and metric_date >= $2::date and metric_date < $3::date), 0
     ) as total`,
    [clientId, range.start, range.end],
  );
  return Number(result.rows[0].total);
}

async function checkAdSpendAnomaly(pool: pg.Pool, clientId: string, clientName: string, yesterday: { start: Date; end: Date }) {
  if (await alreadyAlertedRecently(pool, clientId, "ads")) return;
  const yesterdaySpend = await getAdSpend(pool, clientId, yesterday);
  if (yesterdaySpend === 0) return;
  // Trailing 7 complete days before yesterday (daysAgo=2..8), not including yesterday itself.
  const trailingStart = getIstDayBoundaries(8).start;
  const trailingEnd = getIstDayBoundaries(2).end;
  const trailingTotal = await getAdSpend(pool, clientId, { start: trailingStart, end: trailingEnd });
  const trailingAverage = trailingTotal / 7;
  if (trailingAverage === 0) return;
  const changePercent = ((yesterdaySpend - trailingAverage) / trailingAverage) * 100;
  if (Math.abs(changePercent) >= 25) {
    const direction = changePercent > 0 ? "increased" : "decreased";
    await insertAndPublish(
      pool,
      clientId,
      clientName,
      "ads",
      "Ad spend anomaly",
      `Ad spend ${direction} ${Math.abs(changePercent).toFixed(0)}% yesterday compared to the trailing 7-day average.`,
    );
  }
}

async function checkBlendedRoas(pool: pg.Pool, clientId: string, clientName: string, yesterday: { start: Date; end: Date }) {
  if (await alreadyAlertedRecently(pool, clientId, "roas")) return;
  const adSpend = await getAdSpend(pool, clientId, yesterday);
  if (adSpend === 0) return;
  const netSalesResult = await pool.query<{ net_sales: string }>(
    `select coalesce(sum(amount) filter (where status <> 'Cancelled'), 0) as net_sales
     from shopify_orders where client_id = $1 and order_date >= $2 and order_date < $3`,
    [clientId, yesterday.start, yesterday.end],
  );
  const netSales = Number(netSalesResult.rows[0].net_sales);
  const roas = netSales / adSpend;
  if (roas < 3.0) {
    await insertAndPublish(
      pool,
      clientId,
      clientName,
      "roas",
      "Blended ROAS below target",
      `Blended ROAS fell to ${roas.toFixed(1)}x yesterday, below the 3.0x target.`,
    );
  }
}

export async function runDailyNotificationChecks(pool: pg.Pool): Promise<void> {
  const yesterday = getIstDayBoundaries(1);
  const weekBefore = getIstDayBoundaries(8);
  const clients = await pool.query<{ id: string; name: string }>("select id, name from clients");
  for (const { id: clientId, name: clientName } of clients.rows) {
    try {
      await checkRto(pool, clientId, clientName, yesterday);
      await checkSalesDip(pool, clientId, clientName, yesterday, weekBefore);
      await checkAdSpendAnomaly(pool, clientId, clientName, yesterday);
      await checkBlendedRoas(pool, clientId, clientName, yesterday);
    } catch (err) {
      // One client's bad data must not stop every other client's checks from running.
      logger.error(err, `Daily notification checks failed for client ${clientId}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run test/lib/notification-checks.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/notification-checks.ts server/test/lib/notification-checks.test.ts
git commit -m "feat(server): add daily RTO/sales-dip/ad-spend-anomaly/blended-ROAS notification checks"
```

---

### Task 6: Register the daily check job in the scheduler

**Files:**
- Modify: `server/src/scheduler.ts`
- Test: `server/test/scheduler.test.ts` (extend existing file — read it first)

**Interfaces:**
- Consumes: `runDailyNotificationChecks` (Task 5).

- [ ] **Step 1: Read the existing test file first**

Read `server/test/scheduler.test.ts` in full — it already tests `startScheduler()`'s registration pattern for the Meta/Google/courier jobs; match that exact style.

- [ ] **Step 2: Write the failing test**

Add to `server/test/scheduler.test.ts` (match the existing file's mocking pattern — it likely already mocks `node-cron`'s `schedule` to capture registered expressions rather than letting them actually fire):

```typescript
it("registers the daily notification checks job once per day, after IST midnight", () => {
  startScheduler();
  const notifJob = scheduledJobs.find((j) => j.expression === "15 0 * * *");
  expect(notifJob).toBeDefined();
});
```

(`scheduledJobs` here refers to whatever variable name the existing test file already uses to capture `cron.schedule` calls — read the file first and match it exactly rather than inventing a new name.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run test/scheduler.test.ts`
Expected: FAIL — no job with that expression registered

- [ ] **Step 4: Register the job**

In `server/src/scheduler.ts`, add the import:
```typescript
import { runDailyNotificationChecks } from "./lib/notification-checks.js";
```

Inside `startScheduler()`, add (after the existing cron registrations, before the function's closing brace):
```typescript
  // Runs once daily, shortly after IST midnight, checking *yesterday's* now-complete
  // data — not a live/frequent poll. See notification-checks.ts and this plan's spec
  // for why checking partial same-day data would produce false positives.
  cron.schedule(
    "15 0 * * *",
    () => {
      runDailyNotificationChecks(pool).catch((err) => logger.error(err, "Daily notification checks failed:"));
    },
    { noOverlap: true },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run test/scheduler.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Type-check and run the full suite**

Run: `cd server && npx tsc --noEmit && TEST_DATABASE_URL="postgres://ishantarora@localhost:5432/d2c_test" JWT_SECRET=test-secret npx vitest run`
Expected: clean type-check, full suite green

- [ ] **Step 7: Commit**

```bash
git add server/src/scheduler.ts server/test/scheduler.test.ts
git commit -m "feat(server): register the daily notification checks cron job"
```

---

### Task 7: Frontend — real, live notifications menu

**Files:**
- Modify: `src/lib/api.ts` (add a stream-subscription helper)
- Modify: `src/components/layout/notifications-menu.tsx` (drop mock data, use real API + live stream)

**Interfaces:**
- Consumes: `apiFetch` (existing), `GET /api/notifications`, `POST /api/notifications/:id/read`, `GET /api/notifications/stream` (Task 3).
- Produces: `subscribeToNotificationStream(onMessage: (n: AppNotification) => void): () => void` in `src/lib/api.ts`.

- [ ] **Step 1: Add the stream-subscription helper**

Read `src/lib/api.ts` first (already read in full above in this session). Add alongside `apiFetch`:

```typescript
// Live notification delivery. The browser's native EventSource can't send this app's
// Bearer-token Authorization header, so this reads the SSE response body manually via
// fetch + a stream reader instead, keeping the exact same auth mechanism as every other
// request. Returns an unsubscribe function that aborts the underlying request.
export function subscribeToNotificationStream(onMessage: (data: unknown) => void): () => void {
  const controller = new AbortController();

  (async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    let res: Response;
    try {
      res = await fetch(`${import.meta.env.VITE_API_URL}/api/notifications/stream`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      });
    } catch {
      return; // connection failed or was aborted before it opened — nothing to clean up
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue; // heartbeat/comment lines have no "data: " prefix
        try {
          onMessage(JSON.parse(line.slice("data: ".length)));
        } catch {
          // malformed event — skip it rather than crash the whole stream
        }
      }
    }
  })();

  return () => controller.abort();
}
```

- [ ] **Step 2: Rewrite the notifications menu**

Read `src/components/layout/notifications-menu.tsx` first (already read in full above in this session). Replace its data-fetching with:

```typescript
import * as React from "react";
import { Bell, TrendingDown, Wallet, Gauge, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiFetch, subscribeToNotificationStream } from "@/lib/api";

type NotificationKind = "rto" | "sales" | "ads" | "roas" | "task";

interface AppNotification {
  id: string;
  clientId: string;
  clientName: string;
  kind: NotificationKind;
  title: string;
  description: string;
  createdAt: string;
  read: boolean;
}

const KIND_META: Record<NotificationKind, { icon: React.ElementType; className: string }> = {
  rto: { icon: TrendingDown, className: "bg-negative-subtle text-negative" },
  sales: { icon: Gauge, className: "bg-warning-subtle text-warning" },
  ads: { icon: Wallet, className: "bg-info-subtle text-info" },
  roas: { icon: TrendingDown, className: "bg-negative-subtle text-negative" },
  task: { icon: ListChecks, className: "bg-brand-subtle text-brand" },
};

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function NotificationsMenu() {
  const [notifications, setNotifications] = React.useState<AppNotification[]>([]);
  const unread = notifications.filter((n) => !n.read).length;

  React.useEffect(() => {
    apiFetch("/api/notifications")
      .then((res) => res.json())
      .then(setNotifications)
      .catch(() => {});

    const unsubscribe = subscribeToNotificationStream((data) => {
      const n = data as AppNotification;
      setNotifications((prev) => [{ ...n, read: false }, ...prev]);
    });
    return unsubscribe;
  }, []);

  const markAllRead = () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    unreadIds.forEach((id) => apiFetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {}));
  };

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((x) => (x.id === id ? { ...x, read: true } : x)));
    apiFetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="relative flex size-8 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary">
          <Bell className="size-[17px]" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-negative text-[9px] font-bold text-white ring-2 ring-surface">
              {unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b border-border-subtle px-3.5 py-2.5">
          <span className="text-[13px] font-semibold">Notifications</span>
          <Button variant="ghost" size="xs" onClick={markAllRead} className="h-6 px-1.5 text-[11px]">
            Mark all read
          </Button>
        </div>
        <div className="scrollbar-thin max-h-[420px] overflow-y-auto">
          {notifications.length === 0 && (
            <div className="px-3.5 py-6 text-center text-[12px] text-text-secondary">No notifications yet.</div>
          )}
          {notifications.map((n) => {
            const meta = KIND_META[n.kind];
            const Icon = meta.icon;
            return (
              <button
                key={n.id}
                onClick={() => markRead(n.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 border-b border-border-subtle px-3.5 py-2.5 text-left transition-colors last:border-0 hover:bg-surface-hover",
                  !n.read && "bg-brand-subtle/30",
                )}
              >
                <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", meta.className)}>
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-text-primary">{n.title}</span>
                    {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-text-secondary">
                    <span className="font-medium text-text-primary">{n.clientName}</span> {n.description}
                  </span>
                  <span className="mt-1 block text-[10.5px] text-text-tertiary">{relativeTime(n.createdAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Note: the "View all notifications" footer button from the old version is dropped — it had no destination (`onClick` was never wired to anything even in the mock version). Not replacing it with a dead button is a correctness improvement, not a scope cut; there's no "all notifications" page in this app to link to.

- [ ] **Step 3: Manual verification (no frontend test harness exists in this repo)**

Run: `npm run build`
Expected: builds clean, no TypeScript errors.

Run the dev server, open the dashboard, open the Notifications bell — confirm it shows real data (or empty state, if nothing's been generated locally yet) instead of the old scripted list. Create a task assigned to yourself in another tab/window and confirm it appears in the bell live, without a page refresh.

- [ ] **Step 4: Remove the now-unused mock exports**

In `src/data/mock.ts`, remove `getNotifications` and the `NOTIF_SCRIPT` array it used (search the file for both). In `src/data/types.ts`, remove `AlertKind` and `AppNotification` if nothing else in the codebase still imports them (grep first: `grep -rn "AlertKind\|AppNotification" src/` — if anything else uses them, leave the types in place and only remove `getNotifications`/`NOTIF_SCRIPT` from `mock.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/components/layout/notifications-menu.tsx src/data/mock.ts src/data/types.ts
git commit -m "feat(frontend): wire the notifications bell to real, live data"
```
