import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { decryptToken } from "../../src/lib/crypto.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

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
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  process.env.FRONTEND_URL = "https://d2c.probild.in";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the whole Shopify install-link flow", () => {
  it("install -> OAuth callback -> claim results in a real, correctly-encrypted connection", async () => {
    // Step 1: hit the public install route, no auth.
    const installRes = await request(app).get("/api/integrations/shopify/install").query({ shop: "abc-fashion" });
    expect(installRes.status).toBe(302);
    const authorizeUrl = new URL(installRes.headers.location);
    const state = authorizeUrl.searchParams.get("state")!;

    // Step 2: Shopify redirects back to our callback with a code + hmac (simulate what
    // Shopify itself would send, exactly like the existing Shopify callback tests do).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_install_secret" }), { status: 200 })),
    );
    const callbackQuery = { shop: "abc-fashion.myshopify.com", code: "auth-code", state };
    const hmac = computeTestHmac(callbackQuery, "test-api-secret");
    const callbackRes = await request(app).get("/api/integrations/shopify/callback").query({ ...callbackQuery, hmac });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("#/connect/claim");
    const pendingId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("pending")!;
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);

    // Step 3: a logged-in team member claims it for a client.
    const claimRes = await request(app)
      .post(`/api/connections/pending/${pendingId}/claim`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ clientId: "abc-fashion" });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body).toEqual({ platform: "shopify", status: "connected", externalAccountId: "abc-fashion.myshopify.com" });

    const row = (await testPool.query("select access_token, external_account_id from platform_connections")).rows[0];
    expect(decryptToken(row.access_token)).toBe("shpat_install_secret");
    expect(row.external_account_id).toBe("abc-fashion.myshopify.com");
    expect(row.access_token).not.toContain("shpat_install_secret");
    expect((await testPool.query("select 1 from pending_connections where id = $1", [pendingId])).rowCount).toBe(0);
  });
});
