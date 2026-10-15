import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cron from "node-cron";
import { testPool, resetTestDb } from "./helpers/test-db.js";
import { encryptToken } from "../src/lib/crypto.js";
import { runScheduledSyncs, startScheduler, hashPlatformToLockKey, sweepExpiredPendingConnections } from "../src/scheduler.js";
import pool from "../src/db.js";
import { connectors } from "../src/lib/connector-registry.js";
import { logger } from "../src/lib/logger.js";

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
});

describe("runScheduledSyncs", () => {
  it("syncs every connected connection for the given platform", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));

    await runScheduledSyncs("shopify");

    const conn = await testPool.query("select last_synced_at from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
  });

  it("retries a connection stuck in error status, and recovers it on success", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('aaaaaaaa-1111-1111-1111-111111111111', 'abc-fashion', 'shopify', 'error', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));

    await runScheduledSyncs("shopify");

    const conn = await testPool.query("select status, last_synced_at from platform_connections where id = $1", [
      "aaaaaaaa-1111-1111-1111-111111111111",
    ]);
    expect(conn.rows[0].status).toBe("connected");
    expect(conn.rows[0].last_synced_at).not.toBeNull();
  });

  it("skips disconnected connections", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('66666666-6666-6666-6666-666666666666', 'abc-fashion', 'shopify', 'disconnected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await runScheduledSyncs("shopify");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs to sync_logs and flips status to error when a sync fails", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('77777777-7777-7777-7777-777777777777', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_real_token")],
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));

    await runScheduledSyncs("shopify");

    const conn = await testPool.query("select status from platform_connections where id = $1", ["77777777-7777-7777-7777-777777777777"]);
    expect(conn.rows[0].status).toBe("error");
    const logs = await testPool.query("select * from sync_logs where connection_id = $1", ["77777777-7777-7777-7777-777777777777"]);
    expect(logs.rowCount).toBe(1);
    expect(logs.rows[0].error).not.toBeNull();
  });

  it("does not overwrite a connection disconnected mid-sync with error when that sync fails", async () => {
    const id = "bbbbbbbb-2222-2222-2222-222222222222";
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ($1, 'abc-fashion', 'shopify', 'connected', $2, 'abc-fashion.myshopify.com')`,
      [id, encryptToken("shpat_real_token")],
    );
    // Simulate the user clicking Disconnect while the scheduled sync is in flight,
    // after which the sync fails.
    const syncSpy = vi.spyOn(connectors.shopify, "sync").mockImplementation(async (connectionId: string) => {
      await testPool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
      throw new Error("boom");
    });

    try {
      await runScheduledSyncs("shopify");
    } finally {
      syncSpy.mockRestore();
    }

    const conn = await testPool.query("select status from platform_connections where id = $1", [id]);
    expect(conn.rows[0].status).toBe("disconnected");
  });

  it("keeps syncing later connections even when the error-recovery queries for an earlier failure also fail", async () => {
    const failingConnectionId = "88888888-8888-8888-8888-888888888888";
    const healthyConnectionId = "99999999-9999-9999-9999-999999999999";

    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ($1, 'abc-fashion', 'shopify', 'connected', $3, 'fail-shop.myshopify.com'),
       ($2, 'abc-fashion', 'shopify', 'connected', $3, 'ok-shop.myshopify.com')`,
      [failingConnectionId, healthyConnectionId, encryptToken("shpat_real_token")],
    );

    // The first connection's own sync fails (Shopify 500s for its shop domain);
    // the second connection's shop domain returns a normal empty-orders response.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("fail-shop")) {
          return new Response("server error", { status: 500 });
        }
        return new Response(JSON.stringify({ orders: [] }), { status: 200 });
      }),
    );

    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    // Mock the real pool used by both the scheduler and the connector so that,
    // specifically for the failing connection's status='error' recovery write,
    // the query itself throws — simulating a DB hiccup during error recovery.
    // Every other pool.query call (the connector's own reads/writes, the
    // healthy connection's whole sync, the sync_logs insert) passes through
    // to the real implementation untouched.
    const originalQuery = pool.query.bind(pool);
    const querySpy = vi.spyOn(pool, "query").mockImplementation(((text: unknown, params?: unknown) => {
      if (
        typeof text === "string" &&
        text.includes("update platform_connections set status = 'error'") &&
        Array.isArray(params) &&
        params[0] === failingConnectionId
      ) {
        return Promise.reject(new Error("simulated recovery db failure"));
      }
      return (originalQuery as (...args: unknown[]) => unknown)(text, params);
    }) as typeof pool.query);

    try {
      await runScheduledSyncs("shopify");
    } finally {
      querySpy.mockRestore();
    }

    // The healthy connection must still have been synced despite the other
    // connection's recovery queries blowing up first in the same loop.
    const healthyConn = await testPool.query(
      "select last_synced_at, status from platform_connections where id = $1",
      [healthyConnectionId],
    );
    expect(healthyConn.rows[0].last_synced_at).not.toBeNull();
    expect(healthyConn.rows[0].status).toBe("connected");

    // The failing connection's recovery write never actually landed (its
    // status update rejected, so it's still "connected" and has no log row) —
    // proving we exercised the recovery-query failure path, not just a plain
    // sync() failure.
    const failingConn = await testPool.query("select status from platform_connections where id = $1", [failingConnectionId]);
    expect(failingConn.rows[0].status).toBe("connected");
    const failingLogs = await testPool.query("select * from sync_logs where connection_id = $1", [failingConnectionId]);
    expect(failingLogs.rowCount).toBe(0);

    // The recovery failure itself was still surfaced via the logger.
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.stringContaining(`Failed to record sync failure for connection ${failingConnectionId}`),
    );

    loggerErrorSpy.mockRestore();
  });

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
});

describe("sweepExpiredPendingConnections", () => {
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
});

describe("startScheduler", () => {
  it("schedules the hourly Shopify sync and a 15-minutely sync for both Meta and Google, offset from each other", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("0 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    expect(scheduleSpy).toHaveBeenCalledWith("*/15 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    expect(scheduleSpy).toHaveBeenCalledWith("3,18,33,48 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });

  it("schedules an hourly Shiprocket sync at minute 15", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("15 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });

  it("schedules an hourly Delhivery sync at minute 30", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("30 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });
});
