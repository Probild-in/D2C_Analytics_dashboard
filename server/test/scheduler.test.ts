import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";
import { encryptToken } from "../src/lib/crypto.js";
import { runScheduledSyncs } from "../src/scheduler.js";

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
});
