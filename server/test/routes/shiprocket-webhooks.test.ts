import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

const CONN = "66666666-6666-6666-6666-666666666666";

beforeEach(async () => {
  await resetTestDb();
  delete process.env.SHIPROCKET_WEBHOOK_API_KEY;
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${CONN}', 'abc-fashion', 'courier_shiprocket', 'connected', 'ops@abc.com')`,
  );
});

afterEach(() => {
  delete process.env.SHIPROCKET_WEBHOOK_API_KEY;
});

describe("POST /api/webhooks/shiprocket/:connectionId/orders", () => {
  it("upserts a shipment from a flat webhook payload", async () => {
    const res = await request(app)
      .post(`/api/webhooks/shiprocket/${CONN}/orders`)
      .send({ awb: "AWB501", current_status: "RTO Initiated", channel_order_id: "501", courier_name: "Delhivery", customer_state: "Maharashtra" });

    expect(res.status).toBe(200);
    const shipment = await testPool.query("select * from shipments where awb = 'AWB501'");
    expect(shipment.rowCount).toBe(1);
    expect(shipment.rows[0]).toMatchObject({
      client_id: "abc-fashion",
      connection_id: CONN,
      order_ref: "501",
      status: "RTO Initiated",
      destination_state: "Maharashtra",
    });
  });

  it("unwraps a { data: {...} } envelope when awb isn't at the top level", async () => {
    const res = await request(app)
      .post(`/api/webhooks/shiprocket/${CONN}/orders`)
      .send({ data: { awb_code: "AWB502", status: "Delivered", order_id: "502" } });

    expect(res.status).toBe(200);
    const shipment = await testPool.query("select * from shipments where awb = 'AWB502'");
    expect(shipment.rows[0]).toMatchObject({ order_ref: "502", status: "Delivered" });
  });

  it("checks x-api-key when SHIPROCKET_WEBHOOK_API_KEY is configured", async () => {
    process.env.SHIPROCKET_WEBHOOK_API_KEY = "test-webhook-key";
    const noKey = await request(app).post(`/api/webhooks/shiprocket/${CONN}/orders`).send({ awb: "AWB503", status: "Delivered" });
    expect(noKey.status).toBe(401);

    const wrongKey = await request(app)
      .post(`/api/webhooks/shiprocket/${CONN}/orders`)
      .set("x-api-key", "wrong-key")
      .send({ awb: "AWB503", status: "Delivered" });
    expect(wrongKey.status).toBe(401);

    const rightKey = await request(app)
      .post(`/api/webhooks/shiprocket/${CONN}/orders`)
      .set("x-api-key", "test-webhook-key")
      .send({ awb: "AWB503", status: "Delivered" });
    expect(rightKey.status).toBe(200);
  });

  it("400s a payload with no recognizable AWB field", async () => {
    const res = await request(app).post(`/api/webhooks/shiprocket/${CONN}/orders`).send({ status: "Delivered" });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown connectionId", async () => {
    const res = await request(app)
      .post(`/api/webhooks/shiprocket/00000000-0000-0000-0000-000000000000/orders`)
      .send({ awb: "AWB504", status: "Delivered" });
    expect(res.status).toBe(404);
    expect((await testPool.query("select * from shipments where awb = 'AWB504'")).rowCount).toBe(0);
  });
});
