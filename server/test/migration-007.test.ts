import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

const CONN = "66666666-6666-6666-6666-666666666666";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${CONN}', 'abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com')`,
  );
});

const insertShipment = (awb: string, status = "In Transit") =>
  testPool.query(
    `insert into shipments (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at)
     values ('abc-fashion', '${CONN}', $1, '1001', 'Delhivery', $2, 'Maharashtra', now())`,
    [awb, status],
  );

describe("migration 007 (shipments)", () => {
  it("stores a shipment with a valid status", async () => {
    await insertShipment("AWB1", "RTO Initiated");
    const res = await testPool.query("select awb, status, delivered_at from shipments");
    expect(res.rows).toEqual([{ awb: "AWB1", status: "RTO Initiated", delivered_at: null }]);
  });

  it("rejects a status outside the OrderStatus set", async () => {
    await expect(insertShipment("AWB2", "Teleported")).rejects.toThrow();
  });

  it("allows one row per (connection, awb)", async () => {
    await insertShipment("AWB3");
    await expect(insertShipment("AWB3")).rejects.toThrow();
  });

  it("deletes shipments when their connection is deleted", async () => {
    await insertShipment("AWB4");
    await testPool.query("delete from platform_connections where id = $1", [CONN]);
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });
});
