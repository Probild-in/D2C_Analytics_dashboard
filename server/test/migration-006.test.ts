import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
});

describe("migration 006", () => {
  it("allows courier_shiprocket as a platform", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com')`,
    );
    const res = await testPool.query("select platform from platform_connections");
    expect(res.rows[0].platform).toBe("courier_shiprocket");
  });

  it("still rejects unknown platforms", async () => {
    await expect(
      testPool.query(
        `insert into platform_connections (client_id, platform, status, external_account_id)
         values ('abc-fashion', 'not_a_platform', 'connected', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it("has a nullable credentials column", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id, credentials)
       values ('abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com', 'enc-blob')`,
    );
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id)
       values ('abc-fashion', 'courier_delhivery', 'connected', 'token-fp')`,
    );
    const res = await testPool.query("select platform, credentials from platform_connections order by platform");
    expect(res.rows).toEqual([
      { platform: "courier_delhivery", credentials: null },
      { platform: "courier_shiprocket", credentials: "enc-blob" },
    ]);
  });
});
