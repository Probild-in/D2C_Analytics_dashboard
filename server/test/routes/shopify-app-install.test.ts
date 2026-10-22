import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signState, verifyState } from "../../src/lib/state-token.js";

// Mints the same kind of token /callback's redirect embeds, directly — the brief's own
// suggested pattern for existing/new tests that need a valid, correctly-scoped token
// without round-tripping through a mocked fetch call just to recover it.
function subscribeTokenFor(clientId: string): Promise<string> {
  return signState({ platform: "shopify-app-store-subscribe", clientId }, "2h");
}
function billingTokenFor(clientId: string): Promise<string> {
  return signState({ platform: "shopify-app-store-billing", clientId }, "2h");
}

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

async function fakeShopifyCallback(
  stateToken: string,
  overrides: { email?: string; name?: string; shopDomain?: string } = {},
) {
  const shopDomain = overrides.shopDomain ?? "newbrand.myshopify.com";
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
  const query = { shop: shopDomain, code: "auth-code", state: stateToken, timestamp: "123" };
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

describe("GET /api/shopify-app/plans", () => {
  it("returns small/medium/large with USD prices, no auth required, excluding enterprise (I3)", async () => {
    const res = await request(app).get("/api/shopify-app/plans");
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id).sort()).toEqual(["large", "medium", "small"]);
    for (const plan of res.body) {
      expect(typeof plan.priceUsd).toBe("number");
      expect(plan.priceUsd).toBeGreaterThan(0);
      expect(plan).not.toHaveProperty("monthlyFeeInr");
    }
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

describe("POST /api/shopify-app/:clientId/subscribe", () => {
  it("creates a Shopify charge and returns its confirmation URL", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const token = callbackUrl.searchParams.get("token")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://newbrand.myshopify.com/admin/api/2024-10/graphql.json");
        return new Response(
          JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }),
          { status: 200 },
        );
      }),
    );
    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm" });

    const subs = await testPool.query("select plan_id, status, billing_provider from subscriptions where client_id = $1", [clientId]);
    expect(subs.rows[0]).toMatchObject({ plan_id: "medium", status: "pending", billing_provider: "shopify" });
  });

  it("rejects enterprise", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const token = callbackUrl.searchParams.get("token")!;
    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "enterprise", token });
    expect(res.status).toBe(400);
  });

  // --- C2: unauthenticated cross-tenant billing corruption, closed ---

  it("rejects a subscribe request with no token", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_token");
    expect((await testPool.query("select 1 from subscriptions where client_id = $1", [clientId])).rowCount).toBe(0);
  });

  it("rejects a subscribe request with a garbage/invalid token", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token: "not-a-real-jwt" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_token");
  });

  it("rejects a subscribe request carrying a token minted for a DIFFERENT clientId", async () => {
    const install1 = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state1 = new URL(install1.headers.location).searchParams.get("state")!;
    const callback1 = await fakeShopifyCallback(state1);
    const clientId1 = new URL(callback1.headers.location.replace("#", "")).searchParams.get("client")!;

    // Attacker guesses a second, unrelated client's id and tries to reuse their OWN
    // legitimately-issued token (for clientId1) against it.
    const res = await request(app)
      .post(`/api/shopify-app/some-other-guessed-client-id/subscribe`)
      .send({ planId: "medium", token: await subscribeTokenFor(clientId1) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_token");
  });

  it("rejects a subscribe request against a client with no shopify_shop_domain, even with a validly-scoped token", async () => {
    // Defense in depth: simulates a leaked/forged-somehow token for a clientId that was
    // never actually provisioned through the Shopify App Store install flow at all.
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('agency-only-client', 'Agency Only Client', 'Uncategorized', 'bg-orange-500', 'A')`,
    );
    const res = await request(app)
      .post(`/api/shopify-app/agency-only-client/subscribe`)
      .send({ planId: "medium", token: await subscribeTokenFor("agency-only-client") });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("refuses to switch a client already billed via Razorpay", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    // Simulates a client that separately connected Shopify for data sync while already on
    // an active Razorpay plan (the real pre-existing agency-connect flow this isolation
    // discipline protects).
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ($1, 'medium', 'active', 'razorpay_sub_1', 'razorpay')`,
      [clientId],
    );

    const res = await request(app)
      .post(`/api/shopify-app/${clientId}/subscribe`)
      .send({ planId: "small", token: await subscribeTokenFor(clientId) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("billing_provider_conflict");
    const sub = await testPool.query("select billing_provider from subscriptions where client_id = $1", [clientId]);
    expect(sub.rows[0].billing_provider).toBe("razorpay");
  });

  it("uses the connection matching shopify_shop_domain when a client has more than one Shopify connection (I5)", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state, { email: "owner@multiconn.com", name: "Multi Conn" });
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const token = callbackUrl.searchParams.get("token")!;

    // A second, unrelated Shopify connection for the same client (e.g. the
    // extra_shopify_stores plan feature) — inserted BEFORE the real one alphabetically/by
    // insertion order, so a naive `rows[0]` pick would grab this one instead.
    await testPool.query(
      `insert into platform_connections (client_id, platform, external_account_id, access_token, status) values
       ($1, 'shopify', 'other-store.myshopify.com', 'encrypted-placeholder', 'connected')`,
      [clientId],
    );

    let calledShop: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calledShop = new URL(url).hostname;
        return new Response(
          JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }),
          { status: 200 },
        );
      }),
    );
    const res = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token });
    expect(res.status).toBe(200);
    expect(calledShop).toBe("newbrand.myshopify.com");
  });
});

describe("GET /api/shopify-app/billing-callback", () => {
  it("activates the subscription and redirects through a real magic link on approval", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const subscribeToken = callbackUrl.searchParams.get("token")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/graphql.json")) {
          const body = JSON.parse(init?.body as string);
          if (body.query.includes("appSubscriptionCreate")) {
            return new Response(JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: { node: { status: "ACTIVE", name: "Medium" } } }), { status: 200 });
        }
        if (url.includes("/admin/generate_link")) {
          return new Response(JSON.stringify({ properties: { action_link: "https://test-project.supabase.co/auth/v1/verify?token=magic" } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token: subscribeToken });

    const billingToken = await billingTokenFor(clientId);
    const res = await request(app).get("/api/shopify-app/billing-callback").query({ client: clientId, charge_id: "1", token: billingToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://test-project.supabase.co/auth/v1/verify?token=magic");

    const subs = await testPool.query("select status from subscriptions where client_id = $1", [clientId]);
    expect(subs.rows[0].status).toBe("active");
  });

  it("on decline, redirects with a fresh, valid subscribe token so the merchant can retry — not a dead end", async () => {
    // Regression test: an earlier version of this fix wave's token scheme redirected a
    // declined merchant back to the plan picker with NO token at all, which the frontend's
    // choose() (now requiring a token) would silently no-op against — a merchant whose
    // charge was declined had no way to retry short of uninstalling and reinstalling.
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "declinedbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const subscribeToken = callbackUrl.searchParams.get("token")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/graphql.json")) {
          const body = JSON.parse(init?.body as string);
          if (body.query.includes("appSubscriptionCreate")) {
            return new Response(JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://declinedbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: { node: { status: "PENDING", name: "Medium" } } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token: subscribeToken });

    const billingToken = await billingTokenFor(clientId);
    const res = await request(app).get("/api/shopify-app/billing-callback").query({ client: clientId, charge_id: "1", token: billingToken });
    expect(res.status).toBe(302);
    const redirectUrl = new URL(res.headers.location.replace("#", ""));
    expect(redirectUrl.pathname).toBe("//shopify-app/plans");
    expect(redirectUrl.searchParams.get("billing")).toBe("declined");
    expect(redirectUrl.searchParams.get("client")).toBe(clientId);

    // The core assertion: the retry token is present AND actually valid/correctly-scoped —
    // not just any string — proving a merchant can genuinely retry picking a plan from here.
    const retryToken = redirectUrl.searchParams.get("token");
    expect(retryToken).toBeTruthy();
    const payload = await verifyState(retryToken!);
    expect(payload.platform).toBe("shopify-app-store-subscribe");
    expect(payload.clientId).toBe(clientId);

    // Prove it's not just well-formed but actually usable: retry /subscribe with it.
    const retryRes = await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "small", token: retryToken });
    expect(retryRes.status).toBe(200);
  });

  it("trusts Shopify's own charge_id over a DB row that drifted to a later, still-pending charge", async () => {
    // Exploit scenario: merchant calls /subscribe twice before approving either tab (e.g. a
    // double-click or retry). The second call creates a NEW Shopify charge and overwrites the
    // DB row to point at it, even though the FIRST charge is the one the merchant actually goes
    // on to approve. billing-callback must trust Shopify's own charge_id query param — not
    // whatever gid currently sits in the DB row — or it will misreport the approved charge as
    // declined and leave the DB pointed at the wrong (still-pending) subscription.
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const subscribeToken = callbackUrl.searchParams.get("token")!;

    const firstGid = "gid://shopify/AppSubscription/1";
    const secondGid = "gid://shopify/AppSubscription/2";
    let createCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/graphql.json")) {
          const body = JSON.parse(init?.body as string);
          if (body.query.includes("appSubscriptionCreate")) {
            createCallCount += 1;
            const gid = createCallCount === 1 ? firstGid : secondGid;
            const chargeNumericId = createCallCount === 1 ? "1" : "2";
            return new Response(
              JSON.stringify({
                data: {
                  appSubscriptionCreate: {
                    appSubscription: { id: gid },
                    confirmationUrl: `https://newbrand.myshopify.com/admin/charges/${chargeNumericId}/confirm`,
                    userErrors: [],
                  },
                },
              }),
              { status: 200 },
            );
          }
          // getAppSubscription: report the FIRST charge as ACTIVE (the one actually
          // approved) and the SECOND (what the DB row would wrongly point at) as pending.
          const variables = body.variables as { id: string };
          const status = variables.id === firstGid ? "ACTIVE" : "PENDING";
          return new Response(JSON.stringify({ data: { node: { status, name: "Medium" } } }), { status: 200 });
        }
        if (url.includes("/admin/generate_link")) {
          return new Response(JSON.stringify({ properties: { action_link: "https://test-project.supabase.co/auth/v1/verify?token=magic" } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    // Two /subscribe calls — the second overwrites the DB row to point at the second gid.
    await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token: subscribeToken });
    await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token: subscribeToken });

    const afterSubscribe = await testPool.query("select gateway_subscription_id from subscriptions where client_id = $1", [clientId]);
    expect(afterSubscribe.rows[0].gateway_subscription_id).toBe(secondGid);

    // The merchant approves the FIRST charge; Shopify redirects with its charge_id.
    const billingToken = await billingTokenFor(clientId);
    const res = await request(app).get("/api/shopify-app/billing-callback").query({ client: clientId, charge_id: "1", token: billingToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://test-project.supabase.co/auth/v1/verify?token=magic");

    const subs = await testPool.query("select status, gateway_subscription_id from subscriptions where client_id = $1", [clientId]);
    expect(subs.rows[0].status).toBe("active");
    expect(subs.rows[0].gateway_subscription_id).toBe(firstGid);
  });

  // --- C1: unauthenticated account takeover, closed ---

  it("redirects to the error page instead of issuing a magic link when the token is missing", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    // Even an ACTIVE subscription must not be enough on its own.
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ($1, 'medium', 'active', 'gid://shopify/AppSubscription/1', 'shopify')`,
      [clientId],
    );

    const res = await request(app).get("/api/shopify-app/billing-callback").query({ client: clientId, charge_id: "1" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/shopify-app/error");
    expect(res.headers.location).not.toContain("supabase.co");
  });

  it("redirects to the error page instead of issuing a magic link when the token is invalid/garbage", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;

    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ($1, 'medium', 'active', 'gid://shopify/AppSubscription/1', 'shopify')`,
      [clientId],
    );

    const res = await request(app)
      .get("/api/shopify-app/billing-callback")
      .query({ client: clientId, charge_id: "1", token: "not-a-real-jwt" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/shopify-app/error");
  });

  it("redirects to the error page when the token is validly-signed but for a DIFFERENT clientId — the core account-takeover guard", async () => {
    // Attacker's own shop legitimately generated a real billing token for ITS OWN
    // clientId, then tries to replay it against a victim's guessed clientId.
    const install1 = await request(app).get("/api/shopify-app/install").query({ shop: "attackershop" });
    const state1 = new URL(install1.headers.location).searchParams.get("state")!;
    const callback1 = await fakeShopifyCallback(state1, {
      email: "attacker@example.com",
      name: "Attacker Shop",
      shopDomain: "attackershop.myshopify.com",
    });
    const attackerClientId = new URL(callback1.headers.location.replace("#", "")).searchParams.get("client")!;
    const attackerToken = await billingTokenFor(attackerClientId);

    const install2 = await request(app).get("/api/shopify-app/install").query({ shop: "victimshop" });
    const state2 = new URL(install2.headers.location).searchParams.get("state")!;
    const callback2 = await fakeShopifyCallback(state2, {
      email: "victim@example.com",
      name: "Victim Shop",
      shopDomain: "victimshop.myshopify.com",
    });
    const victimClientId = new URL(callback2.headers.location.replace("#", "")).searchParams.get("client")!;
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ($1, 'medium', 'active', 'gid://shopify/AppSubscription/1', 'shopify')`,
      [victimClientId],
    );

    const res = await request(app)
      .get("/api/shopify-app/billing-callback")
      .query({ client: victimClientId, charge_id: "1", token: attackerToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/shopify-app/error");
    expect(res.headers.location).not.toContain("supabase.co");
  });

  it("redirects to the error page when charge_id is missing, even with a validly-scoped token (no more stored-gateway-id fallback)", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state);
    const clientId = new URL(callbackRes.headers.location.replace("#", "")).searchParams.get("client")!;
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ($1, 'medium', 'active', 'gid://shopify/AppSubscription/1', 'shopify')`,
      [clientId],
    );

    const res = await request(app)
      .get("/api/shopify-app/billing-callback")
      .query({ client: clientId, token: await billingTokenFor(clientId) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://d2c.probild.in/#/shopify-app/error");
  });

  it("uses the connection matching shopify_shop_domain when a client has more than one Shopify connection (I5)", async () => {
    const installRes = await request(app).get("/api/shopify-app/install").query({ shop: "newbrand" });
    const state = new URL(installRes.headers.location).searchParams.get("state")!;
    const callbackRes = await fakeShopifyCallback(state, { email: "owner@multiconnbill.com", name: "Multi Conn Bill" });
    const callbackUrl = new URL(callbackRes.headers.location.replace("#", ""));
    const clientId = callbackUrl.searchParams.get("client")!;
    const subscribeToken = callbackUrl.searchParams.get("token")!;

    await testPool.query(
      `insert into platform_connections (client_id, platform, external_account_id, access_token, status) values
       ($1, 'shopify', 'other-store.myshopify.com', 'encrypted-placeholder', 'connected')`,
      [clientId],
    );

    const calledShops: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/graphql.json")) {
          calledShops.push(new URL(url).hostname);
          const body = JSON.parse(init?.body as string);
          if (body.query.includes("appSubscriptionCreate")) {
            return new Response(JSON.stringify({ data: { appSubscriptionCreate: { appSubscription: { id: "gid://shopify/AppSubscription/1" }, confirmationUrl: "https://newbrand.myshopify.com/admin/charges/1/confirm", userErrors: [] } } }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: { node: { status: "ACTIVE", name: "Medium" } } }), { status: 200 });
        }
        if (url.includes("/admin/generate_link")) {
          return new Response(JSON.stringify({ properties: { action_link: "https://test-project.supabase.co/auth/v1/verify?token=magic" } }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    await request(app).post(`/api/shopify-app/${clientId}/subscribe`).send({ planId: "medium", token: subscribeToken });

    const billingToken = await billingTokenFor(clientId);
    const res = await request(app).get("/api/shopify-app/billing-callback").query({ client: clientId, charge_id: "1", token: billingToken });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://test-project.supabase.co/auth/v1/verify?token=magic");
    expect(calledShops.every((shop) => shop === "newbrand.myshopify.com")).toBe(true);
  });
});
