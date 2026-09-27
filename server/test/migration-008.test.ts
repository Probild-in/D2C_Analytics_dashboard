import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

const CONN_A = "66666666-6666-6666-6666-666666666666";
const CONN_B = "77777777-7777-7777-7777-777777777777";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  // Two different Shiprocket API-user connections for the SAME client — the
  // reconnect-with-a-new-email scenario that used to create a second connection_id.
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${CONN_A}', 'abc-fashion', 'courier_shiprocket', 'connected', 'old-ops@abc.com'),
     ('${CONN_B}', 'abc-fashion', 'courier_shiprocket', 'connected', 'new-ops@abc.com')`,
  );
});

describe("migration 008 (shipments unique per client, not per connection)", () => {
  it("upserts the same AWB synced under a different connection_id into a single row per (client_id, awb)", async () => {
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at)
       values ('abc-fashion', $1, 'AWB1', 'Delhivery', 'In Transit', now())
       on conflict (client_id, awb)
       do update set connection_id = excluded.connection_id, status = excluded.status`,
      [CONN_A],
    );
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at)
       values ('abc-fashion', $1, 'AWB1', 'Delhivery', 'Delivered', now())
       on conflict (client_id, awb)
       do update set connection_id = excluded.connection_id, status = excluded.status`,
      [CONN_B],
    );

    const res = await testPool.query("select connection_id, status from shipments where client_id = 'abc-fashion' and awb = 'AWB1'");
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toEqual({ connection_id: CONN_B, status: "Delivered" });
  });

  it("allows one row per (client_id, awb) even across different connections", async () => {
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at)
       values ('abc-fashion', $1, 'AWB2', 'Delhivery', 'In Transit', now())`,
      [CONN_A],
    );
    await expect(
      testPool.query(
        `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at)
         values ('abc-fashion', $1, 'AWB2', 'Delhivery', 'In Transit', now())`,
        [CONN_B],
      ),
    ).rejects.toThrow();
  });
});
