import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { encryptToken } from "../../src/lib/crypto.js";

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

describe("GET /api/clients/:id/connections", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, access_token, external_account_id) values
       ('abc-fashion', 'shopify', 'connected', $1, 'abc-fashion.myshopify.com')`,
      [encryptToken("shpat_secret")],
    );
  });

  it("returns connections without exposing tokens", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/connections")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      platform: "shopify",
      status: "connected",
      externalAccountId: "abc-fashion.myshopify.com",
    });
    expect(res.body[0].accessToken).toBeUndefined();
    expect(res.body[0].access_token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("shpat_secret");
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/connections")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
