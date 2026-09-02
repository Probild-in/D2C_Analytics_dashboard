import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signState } from "../../src/lib/state-token.js";

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

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
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.FRONTEND_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/integrations/:platform/callback", () => {
  it("creates a connection and redirects to the frontend on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_real_token" }), { status: 200 })),
    );
    const state = await signState({
      clientId: "abc-fashion",
      platform: "shopify",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
      shopDomain: "abc-fashion.myshopify.com",
    });
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state };
    const hmac = computeTestHmac(query, "test-api-secret");
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ ...query, hmac });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/manage-clients");
    expect(res.headers.location).toContain("connection=success");

    const conn = await testPool.query("select * from platform_connections where client_id = $1", ["abc-fashion"]);
    expect(conn.rowCount).toBe(1);
    expect(conn.rows[0].status).toBe("connected");
    expect(conn.rows[0].access_token).not.toBe("shpat_real_token");
    expect(conn.rows[0].access_token.length).toBeGreaterThan(0);
  });

  it("redirects with an error and creates no connection when state is invalid", async () => {
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ shop: "abc-fashion.myshopify.com", code: "auth-code", state: "not-a-real-token" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    const conn = await testPool.query("select * from platform_connections");
    expect(conn.rowCount).toBe(0);
  });

  it("redirects with an error and creates no connection when the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    const state = await signState({
      clientId: "abc-fashion",
      platform: "shopify",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
      shopDomain: "abc-fashion.myshopify.com",
    });
    const query = { shop: "abc-fashion.myshopify.com", code: "auth-code", state };
    const hmac = computeTestHmac(query, "test-api-secret");
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ ...query, hmac });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    const conn = await testPool.query("select * from platform_connections");
    expect(conn.rowCount).toBe(0);
  });

  it("redirects with an error and creates no connection when the shop param doesn't match the signed state's shopDomain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_real_token" }), { status: 200 })));
    const state = await signState({
      clientId: "abc-fashion",
      platform: "shopify",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
      shopDomain: "abc-fashion.myshopify.com",
    });
    const query = { shop: "a-different-shop.myshopify.com", code: "auth-code", state };
    const hmac = computeTestHmac(query, "test-api-secret");
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ ...query, hmac });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    const conn = await testPool.query("select * from platform_connections");
    expect(conn.rowCount).toBe(0);
  });

  it("redirects with an error and creates no connection when the hmac is missing", async () => {
    const state = await signState({
      clientId: "abc-fashion",
      platform: "shopify",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
      shopDomain: "abc-fashion.myshopify.com",
    });
    const res = await request(app)
      .get("/api/integrations/shopify/callback")
      .query({ shop: "abc-fashion.myshopify.com", code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    const conn = await testPool.query("select * from platform_connections");
    expect(conn.rowCount).toBe(0);
  });
});
