import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const SCOPED = "22222222-2222-2222-2222-222222222222";
const CONN = "66666666-6666-6666-6666-666666666666";
const CONN_B = "77777777-7777-7777-7777-777777777777";
const get = (path: string, sub = RIYA, email = "riya@agency.com") =>
  request(app).get(path).set("Authorization", `Bearer ${signTestJwt({ sub, email })}`);

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
     ('${SCOPED}', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion', 'bg-violet-500', 'A'),
     ('xyz-beauty', 'XYZ Beauty', 'Beauty', 'bg-rose-500', 'X')`,
  );
  await testPool.query(`insert into team_member_clients (team_member_id, client_id) values ('${SCOPED}', 'xyz-beauty')`);
});

async function connectCourier(id: string, clientId: string, status = "connected") {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id)
     values ($1, $2, 'courier_shiprocket', $3, $4)`,
    [id, clientId, status, `${clientId}@ops.com`],
  );
}

async function addShipment(connId: string, clientId: string, awb: string, courier: string, status: string, orderedDaysAgo: number | null, deliveredDaysAgo: number | null = null) {
  await testPool.query(
    `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at, delivered_at)
     values ($1, $2, $3, $4, $5,
       case when $6::int is null then null else now() - ($6::int * interval '1 day') end,
       case when $7::int is null then null else now() - ($7::int * interval '1 day') end)`,
    [clientId, connId, awb, courier, status, orderedDaysAgo, deliveredDaysAgo],
  );
}

describe("GET /api/clients/:id/couriers/summary", () => {
  it("reports connected=false and empty data for a client without a courier", async () => {
    const res = await get("/api/clients/abc-fashion/couriers/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, statusCounts: {}, couriers: [] });
  });

  it("404s for a client the user cannot access", async () => {
    const res = await get("/api/clients/abc-fashion/couriers/summary", SCOPED, "scoped@agency.com");
    expect(res.status).toBe(404);
  });

  it("aggregates per courier and per status inside the window", async () => {
    await connectCourier(CONN, "abc-fashion");
    await addShipment(CONN, "abc-fashion", "D1", "Delhivery", "Delivered", 5, 3);
    await addShipment(CONN, "abc-fashion", "D2", "Delhivery", "RTO Initiated", 4);
    await addShipment(CONN, "abc-fashion", "D3", "Delhivery", "NDR", 2);
    await addShipment(CONN, "abc-fashion", "B1", "Bluedart", "Delivered", 6);
    await addShipment(CONN, "abc-fashion", "OLD", "Delhivery", "Delivered", 60, 55); // outside 30 days
    await addShipment(CONN, "abc-fashion", "NODATE", "Delhivery", "Delivered", null); // no order date: excluded

    const res = await get("/api/clients/abc-fashion/couriers/summary?days=30");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.statusCounts).toEqual({ Delivered: 2, "RTO Initiated": 1, NDR: 1 });
    expect(res.body.couriers).toEqual([
      { name: "Delhivery", orders: 3, delivered: 1, rtoPercent: 33.3, ndrPercent: 33.3, avgDeliveryDays: 2 },
      { name: "Bluedart", orders: 1, delivered: 1, rtoPercent: 0, ndrPercent: 0, avgDeliveryDays: null },
    ]);
  });

  it("does not count a disconnected courier as connected", async () => {
    await connectCourier(CONN, "abc-fashion", "disconnected");
    const res = await get("/api/clients/abc-fashion/couriers/summary");
    expect(res.body.connected).toBe(false);
  });

  it("counts a courier connection stuck in error (e.g. a rotated password) as connected", async () => {
    await connectCourier(CONN, "abc-fashion", "error");
    await addShipment(CONN, "abc-fashion", "D1", "Delhivery", "Delivered", 3);
    const res = await get("/api/clients/abc-fashion/couriers/summary");
    expect(res.body.connected).toBe(true);
  });

  it("clientId=all aggregates every accessible client and scoped users only see theirs", async () => {
    await connectCourier(CONN, "abc-fashion");
    await connectCourier(CONN_B, "xyz-beauty");
    await addShipment(CONN, "abc-fashion", "A1", "Delhivery", "Delivered", 3);
    await addShipment(CONN_B, "xyz-beauty", "X1", "Delhivery", "In Transit", 3);
    await addShipment(CONN_B, "xyz-beauty", "X2", "Delhivery", "In Transit", 3);

    const owner = await get("/api/clients/all/couriers/summary");
    expect(owner.body.couriers).toEqual([expect.objectContaining({ name: "Delhivery", orders: 3 })]);

    const scoped = await get("/api/clients/all/couriers/summary", SCOPED, "scoped@agency.com");
    expect(scoped.body.couriers).toEqual([expect.objectContaining({ name: "Delhivery", orders: 2 })]);
  });
});
