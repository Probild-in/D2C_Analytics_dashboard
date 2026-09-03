import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

describe("GET /api/team-members", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A'),
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty & Cosmetics', 'bg-rose-500', 'X')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values
       ('22222222-2222-2222-2222-222222222222', 'abc-fashion')`,
    );
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/team-members");
    expect(res.status).toBe(401);
  });

  it("returns every team member with a display-cased role and their client access", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app).get("/api/team-members").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const riya = res.body.find((m: { id: string }) => m.id === "11111111-1111-1111-1111-111111111111");
    const aditya = res.body.find((m: { id: string }) => m.id === "22222222-2222-2222-2222-222222222222");

    // all_client_access members get every client id, not just the ones in
    // team_member_clients (which is empty for them by design).
    expect(riya).toMatchObject({ name: "Riya Kapoor", email: "riya@agency.com", role: "Owner" });
    expect(riya.clients.sort()).toEqual(["abc-fashion", "xyz-cosmetics"]);

    expect(aditya).toMatchObject({ name: "Aditya Rao", email: "aditya@agency.com", role: "Manager" });
    expect(aditya.clients).toEqual(["abc-fashion"]);
  });
});
