import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/clients", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A', '11111111-1111-1111-1111-111111111111'),
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty & Cosmetics', 'bg-rose-500', 'X', '11111111-1111-1111-1111-111111111111')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values
       ('22222222-2222-2222-2222-222222222222', 'abc-fashion')`,
    );
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/clients");
    expect(res.status).toBe(401);
  });

  it("returns all clients for a user with all_client_access", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app).get("/api/clients").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id).sort()).toEqual(["abc-fashion", "xyz-cosmetics"]);
    expect(res.body[0]).toMatchObject({ logoColor: expect.any(String), logoInitial: expect.any(String) });
    // owner must be the person's display name, not their raw id — the frontend
    // renders this value directly (e.g. Manage Clients' "Owner" column)
    expect(res.body[0].owner).toBe("Riya Kapoor");
  });

  it("returns only scoped clients for a limited user", async () => {
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "aditya@agency.com" });
    const res = await request(app).get("/api/clients").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(["abc-fashion"]);
  });
});
