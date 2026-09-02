import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { encryptToken } from "../../src/lib/crypto.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
    [encryptToken("shpat_real_token")],
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/clients/:id/connections/:platform/sync", () => {
  it("runs the connector's sync and returns records synced", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recordsSynced: 0 });
  });

  it("404s when there's no connection for that platform", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/google/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("429s a second manual sync within 5 minutes of the last one", async () => {
    await testPool.query("update platform_connections set last_synced_at = now() - interval '2 minutes' where id = $1", [
      "55555555-5555-5555-5555-555555555555",
    ]);
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(429);
  });

  it("allows a manual sync when the last one was more than 5 minutes ago", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    await testPool.query("update platform_connections set last_synced_at = now() - interval '10 minutes' where id = $1", [
      "55555555-5555-5555-5555-555555555555",
    ]);
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/connections/shopify/sync")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
