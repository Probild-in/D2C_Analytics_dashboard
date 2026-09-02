import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cron from "node-cron";
import { testPool, resetTestDb } from "./helpers/test-db.js";
import { encryptToken } from "../src/lib/crypto.js";
import { runScheduledSyncs, startScheduler } from "../src/scheduler.js";
import pool from "../src/db.js";

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

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

    // The recovery failure itself was still surfaced to the server's console.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to record sync failure for connection ${failingConnectionId}`),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });
});

describe("startScheduler", () => {
  it("schedules both the hourly Shopify sync and the 6-hourly Meta sync", () => {
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler();
    expect(scheduleSpy).toHaveBeenCalledWith("0 * * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    expect(scheduleSpy).toHaveBeenCalledWith("0 */6 * * *", expect.any(Function), expect.objectContaining({ noOverlap: true }));
    scheduleSpy.mockRestore();
  });
});
