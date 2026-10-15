import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

const CONN = "66666666-6666-6666-6666-666666666666";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${CONN}', 'abc-fashion', 'courier_delhivery', 'connected', 'delhivery-token')`,
  );
});

describe("POST /api/webhooks/delhivery/:connectionId/orders", () => {
  it("upserts a shipment from Delhivery's real documented payload shape", async () => {
    const res = await request(app)
      .post(`/api/webhooks/delhivery/${CONN}/orders`)
      .send({
        Shipment: {
          Status: {
            Status: "RTO Initiated",
            StatusDateTime: "2026-10-14T17:10:42.767",
            StatusType: "UD",
            StatusLocation: "Chandigarh_Raiprkln_C (Chandigarh)",
            Instructions: "RTO initiated",
          },
          ReferenceNo: "501",
          AWB: "AWB501",
        },
      });

    expect(res.status).toBe(200);
    const shipment = await testPool.query("select * from shipments where awb = 'AWB501'");
    expect(shipment.rowCount).toBe(1);
    expect(shipment.rows[0]).toMatchObject({
      client_id: "abc-fashion",
      connection_id: CONN,
      order_ref: "501",
      status: "RTO Initiated",
    });
  });

  it("delivering the same AWB twice updates it in place, not duplicated", async () => {
    const payload = (status: string) => ({
      Shipment: { Status: { Status: status, StatusDateTime: "2026-10-14T10:00:00" }, ReferenceNo: "501", AWB: "AWB501" },
    });
    await request(app).post(`/api/webhooks/delhivery/${CONN}/orders`).send(payload("Dispatched"));
    await request(app).post(`/api/webhooks/delhivery/${CONN}/orders`).send(payload("Delivered"));

    const shipments = await testPool.query("select status from shipments where awb = 'AWB501'");
    expect(shipments.rowCount).toBe(1);
    expect(shipments.rows[0].status).toBe("Delivered");
  });

  it("enriches ordered_at from the matched Shopify order when one exists", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('77777777-7777-7777-7777-777777777777', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
    );
    await testPool.query(
      `insert into shopify_orders (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method) values
       ('abc-fashion', '77777777-7777-7777-7777-777777777777', '501', 'Priya Shah', '2026-09-01T10:00:00Z', 1000, 'Dispatched', 'COD')`,
    );

    await request(app)
      .post(`/api/webhooks/delhivery/${CONN}/orders`)
      .send({ Shipment: { Status: { Status: "Delivered" }, ReferenceNo: "501", AWB: "AWB501" } });

    const shipment = await testPool.query("select ordered_at from shipments where awb = 'AWB501'");
    expect(new Date(shipment.rows[0].ordered_at).toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("400s a payload with no AWB", async () => {
    const res = await request(app)
      .post(`/api/webhooks/delhivery/${CONN}/orders`)
      .send({ Shipment: { Status: { Status: "Delivered" }, ReferenceNo: "501" } });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown connectionId", async () => {
    const res = await request(app)
      .post(`/api/webhooks/delhivery/00000000-0000-0000-0000-000000000000/orders`)
      .send({ Shipment: { Status: { Status: "Delivered" }, ReferenceNo: "501", AWB: "AWB501" } });
    expect(res.status).toBe(404);
    expect((await testPool.query("select * from shipments where awb = 'AWB501'")).rowCount).toBe(0);
  });

  it("404s for a disconnected connection", async () => {
    await testPool.query("update platform_connections set status = 'disconnected' where id = $1", [CONN]);
    const res = await request(app)
      .post(`/api/webhooks/delhivery/${CONN}/orders`)
      .send({ Shipment: { Status: { Status: "Delivered" }, ReferenceNo: "501", AWB: "AWB501" } });
    expect(res.status).toBe(404);
  });
});
