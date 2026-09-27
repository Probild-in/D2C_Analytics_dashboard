import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { decryptToken } from "../../src/lib/crypto.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
  await testPool.query(
    `insert into shopify_orders
       (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, tracking_number, tracking_company)
     values ('abc-fashion', '55555555-5555-5555-5555-555555555555', '1001', 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', 'AWB1', 'Delhivery Surface')`,
  );
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubDelhivery() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "In Transit" } } }] }), { status: 200 })),
  );
}

const connect = (credentials: unknown) =>
  request(app)
    .post("/api/clients/abc-fashion/connections/courier_delhivery/connect")
    .set("Authorization", `Bearer ${token()}`)
    .send({ credentials });

describe("connecting Delhivery end to end", () => {
  it("connects without a live call, then a manual sync writes shipments from Shopify tracking numbers", async () => {
    const res = await connect({ token: "my-secret-token" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "courier_delhivery", status: "connected", externalAccountId: "delhivery-token" });

    const row = (await testPool.query("select credentials from platform_connections where platform = 'courier_delhivery'")).rows[0];
    expect(JSON.parse(decryptToken(row.credentials))).toEqual({ token: "my-secret-token" });
    expect(row.credentials).not.toContain("my-secret-token");

    stubDelhivery();
    const sync = await request(app)
      .post("/api/clients/abc-fashion/connections/courier_delhivery/sync")
      .set("Authorization", `Bearer ${token()}`);
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ recordsSynced: 1 });
    expect((await testPool.query("select awb, status, courier_name from shipments")).rows).toEqual([
      { awb: "AWB1", status: "In Transit", courier_name: "Delhivery" },
    ]);
  });

  it("rejects a blank token with no connection created", async () => {
    const res = await connect({ token: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("credentials_rejected");
    expect((await testPool.query("select 1 from platform_connections where platform = 'courier_delhivery'")).rowCount).toBe(0);
  });
});
