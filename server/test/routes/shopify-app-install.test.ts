import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

function computeTestHmac(query: Record<string, string>, secret: string): string {
  const { hmac, ...rest } = query;
  const message = Object.keys(rest).sort().map((key) => `${key}=${rest[key]}`).join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

beforeEach(async () => {
  await resetTestDb();
  process.env.SHOPIFY_APP_STORE_CLIENT_ID = "test-app-store-client-id";
  process.env.SHOPIFY_APP_STORE_CLIENT_SECRET = "test-app-store-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
  process.env.FRONTEND_URL = "https://d2c.probild.in";
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  // Needed by createSupabaseUser/deleteSupabaseUser (provisioning) and by encryptToken
  // (storing the Shopify access token) — the brief's test only set the OAuth/state vars,
  // but the actual route also touches Supabase and the credential-encryption key, so
  // every test that reaches provisioning needs these too (same values other route tests
  // in this suite, e.g. signup.test.ts / connections.test.ts, already use).
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fakeShopifyCallback(stateToken: string, overrides: { email?: string; name?: string } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/admin/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "shpat_newbrand_token" }), { status: 200 });
      }
      if (url.includes("/shop.json")) {
        return new Response(
          JSON.stringify({ shop: { email: overrides.email ?? "owner@newbrand.com", name: overrides.name ?? "New Brand Co" } }),
          { status: 200 },
        );
      }
      // Supabase admin user create/delete — the brief's stub didn't cover this endpoint
      // at all, so any test that reaches provisioning (a brand-new shop) would otherwise
      // hit the "Unexpected fetch" branch. A real DELETE (compensating cleanup of an
      // orphaned user) and a real create both hit this same path, distinguished by method.
      if (url.includes("/auth/v1/admin/users")) {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 200 });
        }
        // A fresh random id per call matters for the concurrency test below: two
        // near-simultaneous callbacks each create their OWN distinct Supabase user
        // (Supabase has no idea they're racing each other), and exactly one of those
        // two users must end up deleted as the losing attempt's orphan.
        return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  const query = { shop: "newbrand.myshopify.com", code: "auth-code", state: stateToken, timestamp: "123" };
  const hmac = computeTestHmac(query, "test-app-store-secret");
  return request(app).get("/api/shopify-app/callback").query({ ...query, hmac });
}

describe("GET /api/shopify-app/install", () => {
  it("redirects to Shopify's authorize screen with this app's own client id, no auth required", async () => {
    const res = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://newbrand.myshopify.com/admin/oauth/authorize");
    expect(res.headers.location).toContain("client_id=test-app-store-client-id");
  });

  it("redirects to a friendly error for an unrecognizable shop", async () => {
    const res = await request(app).get("/api/shopify-app/install").query({ shop: "not a store" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
  });
});

describe("GET /api/shopify-app/callback", () => {
  it("provisions a new client, owner, and Shopify connection, then redirects to the plan picker", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;

    const res = await fakeShopifyCallback(state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");

    const clients = await testPool.query("select id, name, category, shopify_shop_domain from clients where shopify_shop_domain = 'newbrand.myshopify.com'");
    expect(clients.rowCount).toBe(1);
    expect(clients.rows[0]).toMatchObject({ name: "New Brand Co", category: "Uncategorized" });

    const teamMembers = await testPool.query("select name, email, role, account_type from team_members where email = 'owner@newbrand.com'");
    expect(teamMembers.rows[0]).toMatchObject({ role: "owner", account_type: "self_serve_owner" });

    const connections = await testPool.query("select platform, external_account_id from platform_connections where client_id = $1", [clients.rows[0].id]);
    expect(connections.rows[0]).toMatchObject({ platform: "shopify", external_account_id: "newbrand.myshopify.com" });
  });

  it("reuses the existing client on a reinstall, rather than creating a duplicate", async () => {
    const install1 = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state1 = new URL(install1.headers.location).searchParams.get("state")!;
    await fakeShopifyCallback(state1);

    const install2 = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state2 = new URL(install2.headers.location).searchParams.get("state")!;
    const res2 = await fakeShopifyCallback(state2);
    expect(res2.status).toBe(302);

    const clients = await testPool.query("select count(*)::int as count from clients where shopify_shop_domain = 'newbrand.myshopify.com'");
    expect(clients.rows[0].count).toBe(1);
  });

  it("rejects an invalid HMAC", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const res = await request(app)
      .get("/api/shopify-app/callback")
      .query({ shop: "newbrand.myshopify.com", code: "auth-code", state, hmac: "0".repeat(64) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'newbrand.myshopify.com'")).rowCount).toBe(0);
  });

  it("only lets one of two concurrent callbacks for the same new shop create a client", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "shpat_newbrand_token" }), { status: 200 });
        if (url.includes("/shop.json")) return new Response(JSON.stringify({ shop: { email: "owner@newbrand.com", name: "New Brand Co" } }), { status: 200 });
        if (url.includes("/auth/v1/admin/users")) {
          if (init?.method === "DELETE") return new Response(null, { status: 200 });
          return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const query = { shop: "newbrand.myshopify.com", code: "auth-code", state, timestamp: "123" };
    const hmac = computeTestHmac(query, "test-app-store-secret");
    const [first, second] = await Promise.all([
      request(app).get("/api/shopify-app/callback").query({ ...query, hmac }),
      request(app).get("/api/shopify-app/callback").query({ ...query, hmac }),
    ]);
    expect([first.status, second.status]).toEqual([302, 302]);
    // Both must redirect to the SAME real client's plan picker — not one success + one
    // error page — which is what actually proves the loser adopted the winner's clientId
    // rather than merely failing safely.
    expect(first.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");
    expect(second.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");
    const firstClientId = new URL(first.headers.location).searchParams.get("client");
    const secondClientId = new URL(second.headers.location).searchParams.get("client");
    expect(firstClientId).toBe(secondClientId);
    const clients = await testPool.query("select count(*)::int as count from clients where shopify_shop_domain = 'newbrand.myshopify.com'");
    expect(clients.rows[0].count).toBe(1);
  });

  it("sends a genuine cross-shop email collision to the error page, without poisoning the connection pool", async () => {
    // Two DIFFERENT, brand-new shops whose shop-owner email happens to be the same
    // (e.g. one merchant runs two stores under one email). This is NOT the same-shop
    // race the concurrency test above covers — these are two sequential, unrelated
    // requests, and Supabase's own email-uniqueness check is expected to reject the
    // second one for real, the same way it would outside any test.
    const install1 = await request(app).get("/api/shopify-app/install").query({ shop: "firstshop" });
    const state1 = new URL(install1.headers.location).searchParams.get("state")!;
    const install2 = await request(app).get("/api/shopify-app/install").query({ shop: "secondshop" });
    const state2 = new URL(install2.headers.location).searchParams.get("state")!;

    let adminUsersCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/admin/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "shpat_token" }), { status: 200 });
        }
        if (url.includes("/shop.json")) {
          // firstshop and secondshop's owners share the same email — the real-world
          // trigger for a genuine GoTrue email collision between two unrelated
          // provisioning attempts. thirdshop gets its own distinct email so the
          // pool-health check below isn't itself blocked by that same collision.
          if (url.includes("firstshop")) {
            return new Response(JSON.stringify({ shop: { email: "shared-owner@example.com", name: "First Shop" } }), { status: 200 });
          }
          if (url.includes("secondshop")) {
            return new Response(JSON.stringify({ shop: { email: "shared-owner@example.com", name: "Second Shop" } }), { status: 200 });
          }
          return new Response(JSON.stringify({ shop: { email: "owner@thirdshop.com", name: "Third Shop" } }), { status: 200 });
        }
        if (url.includes("/auth/v1/admin/users")) {
          if (init?.method === "DELETE") {
            return new Response(null, { status: 200 });
          }
          adminUsersCallCount += 1;
          // Only the SECOND createSupabaseUser call (secondshop, colliding email) is
          // rejected — the first (firstshop) and third (thirdshop, distinct email)
          // calls both succeed, same as real GoTrue would behave.
          if (adminUsersCallCount === 2) {
            // GoTrue's real shape for a duplicate-email rejection (see
            // supabase-admin.ts's createSupabaseUser, which matches on error_code).
            return new Response(JSON.stringify({ error_code: "email_exists", msg: "A user with this email address has already been registered" }), { status: 422 });
          }
          return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const query1 = { shop: "firstshop.myshopify.com", code: "auth-code", state: state1, timestamp: "123" };
    const hmac1 = computeTestHmac(query1, "test-app-store-secret");
    const first = await request(app).get("/api/shopify-app/callback").query({ ...query1, hmac: hmac1 });
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");

    const query2 = { shop: "secondshop.myshopify.com", code: "auth-code", state: state2, timestamp: "123" };
    const hmac2 = computeTestHmac(query2, "test-app-store-secret");
    const second = await request(app).get("/api/shopify-app/callback").query({ ...query2, hmac: hmac2 });
    expect(second.status).toBe(302);
    expect(second.headers.location).toContain("https://d2c.probild.in/#/shopify-app/error");

    // The second attempt's transaction must not have left a connection "idle in
    // transaction" in the shared pool — a subsequent, unrelated request should still
    // work normally.
    const install3 = await request(app).get("/api/shopify-app/install").query({ shop: "thirdshop" });
    const state3 = new URL(install3.headers.location).searchParams.get("state")!;
    const query3 = { shop: "thirdshop.myshopify.com", code: "auth-code", state: state3, timestamp: "123" };
    const hmac3 = computeTestHmac(query3, "test-app-store-secret");
    const third = await request(app).get("/api/shopify-app/callback").query({ ...query3, hmac: hmac3 });
    expect(third.status).toBe(302);
    expect(third.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");
  });
});
