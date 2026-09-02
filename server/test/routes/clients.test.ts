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

describe("POST /api/clients", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/clients").send({ name: "New Brand", category: "Fashion" });
    expect(res.status).toBe(401);
  });

  it("creates a client and returns it in the same shape as GET", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "New Brand", category: "Fashion & Apparel" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "New Brand",
      category: "Fashion & Apparel",
      logoInitial: "N",
      owner: "Riya Kapoor",
      status: "healthy",
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.logoColor).toEqual(expect.any(String));

    const row = await testPool.query("select * from clients where id = $1", [res.body.id]);
    expect(row.rowCount).toBe(1);
  });

  it("grants the creator access even without all_client_access", async () => {
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "aditya@agency.com" });
    const createRes = await request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Scoped Creator Brand", category: "Beauty" });
    expect(createRes.status).toBe(201);

    const listRes = await request(app).get("/api/clients").set("Authorization", `Bearer ${token}`);
    expect(listRes.body.map((c: { id: string }) => c.id)).toContain(createRes.body.id);
  });

  it("generates a distinct id when the slug collides with an existing client", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const first = await request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Studio Nine", category: "Fashion" });
    const second = await request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Studio Nine", category: "Fashion" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it("400s for a missing name", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Fashion" });
    expect(res.status).toBe(400);
  });

  it("400s for a missing category", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "New Brand" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/clients/:id", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A', '11111111-1111-1111-1111-111111111111')`,
    );
  });

  it("requires authentication", async () => {
    const res = await request(app).patch("/api/clients/abc-fashion").send({ name: "Renamed" });
    expect(res.status).toBe(401);
  });

  it("updates name and category for an accessible client", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .patch("/api/clients/abc-fashion")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "ABC Fashion Renamed", category: "Apparel" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "abc-fashion", name: "ABC Fashion Renamed", category: "Apparel" });

    const row = await testPool.query("select name, category from clients where id = 'abc-fashion'");
    expect(row.rows[0]).toMatchObject({ name: "ABC Fashion Renamed", category: "Apparel" });
  });

  it("404s for a client the user cannot access", async () => {
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "aditya@agency.com" });
    const res = await request(app)
      .patch("/api/clients/abc-fashion")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent client", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .patch("/api/clients/does-not-exist")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(404);
  });
});
