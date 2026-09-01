import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/couriers", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/couriers");
    expect(res.status).toBe(401);
  });

  it("lists known couriers, all unavailable for now", async () => {
    const token = signTestJwt({ sub: "any-user", email: "someone@agency.com" });
    const res = await request(app).get("/api/couriers").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "courier_delhivery", name: "Delhivery", available: false },
      { id: "courier_shadowfax", name: "Shadowfax", available: false },
    ]);
  });
});
