import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
});

describe("POST /api/enterprise-leads", () => {
  it("stores a lead with no authentication required", async () => {
    const res = await request(app)
      .post("/api/enterprise-leads")
      .send({ name: "Riya Kapoor", email: "riya@bigbrand.com", company: "Big Brand Co", estimatedOrdersPerMonth: 8000, message: "Need a custom plan" });
    expect(res.status).toBe(201);
    const rows = await testPool.query("select name, email, company, estimated_orders_per_month, message from enterprise_leads");
    expect(rows.rows).toEqual([
      { name: "Riya Kapoor", email: "riya@bigbrand.com", company: "Big Brand Co", estimated_orders_per_month: 8000, message: "Need a custom plan" },
    ]);
  });

  it("allows estimatedOrdersPerMonth and message to be omitted", async () => {
    const res = await request(app).post("/api/enterprise-leads").send({ name: "Amit Rao", email: "amit@brand.com", company: "Brand Co" });
    expect(res.status).toBe(201);
  });

  it("400s a missing required field", async () => {
    const res = await request(app).post("/api/enterprise-leads").send({ name: "Riya Kapoor", email: "riya@bigbrand.com" });
    expect(res.status).toBe(400);
  });
});
