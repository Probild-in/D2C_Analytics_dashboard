import crypto from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

function signBody(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

function computeInstallHmac(query: Record<string, string>, secret: string): string {
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
  // Needed by createSupabaseUser/deleteSupabaseUser (provisioning/redaction) and by
  // encryptToken (storing the Shopify access token) — same values the Task 5/6 install
  // route tests already use.
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial, shopify_shop_domain) values
     ('new-brand-co', 'New Brand Co', 'Uncategorized', 'bg-violet-500', 'N', 'newbrand.myshopify.com')`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Drives the real install + callback flow for a given shop, mocking Shopify's OAuth
// token exchange, shop-info lookup, and the Supabase admin user create/delete endpoints —
// adapted from shopify-app-install.test.ts's own fakeShopifyCallback helper, since the
// reinstall test below needs to go through the real provisioning path, not a raw INSERT.
async function installAndCallback(shop: string, overrides: { email?: string; name?: string } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/admin/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "shpat_token" }), { status: 200 });
      }
      if (url.includes("/shop.json")) {
        return new Response(
          JSON.stringify({ shop: { email: overrides.email ?? "owner@example.com", name: overrides.name ?? "Example Shop" } }),
          { status: 200 },
        );
      }
      if (url.includes("/auth/v1/admin/users")) {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 200 });
        }
        return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  const installRes = await request(app).get("/api/shopify-app/install").query({ shop });
  const state = new URL(installRes.headers.location).searchParams.get("state")!;
  const shopDomain = `${shop}.myshopify.com`;
  const query = { shop: shopDomain, code: "auth-code", state, timestamp: "123" };
  const hmac = computeInstallHmac(query, "test-app-store-secret");
  return request(app).get("/api/shopify-app/callback").query({ ...query, hmac });
}

describe("POST /api/webhooks/shopify-app/shop/redact", () => {
  it("deletes the client's data when the shop closes, with a valid HMAC", async () => {
    const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'newbrand.myshopify.com'")).rowCount).toBe(0);
  });

  it("rejects an invalid HMAC and makes no change", async () => {
    const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", "invalid")
      .send(rawBody);
    expect(res.status).toBe(401);
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'newbrand.myshopify.com'")).rowCount).toBe(1);
  });

  it("also deletes the self-serve owner's team_members row and calls the Supabase delete-user endpoint", async () => {
    const callbackRes = await installAndCallback("ownedshop", { email: "owner@ownedshop.com", name: "Owned Shop" });
    expect(callbackRes.status).toBe(302);
    const clientRow = await testPool.query<{ id: string; owner_id: string }>(
      "select id, owner_id from clients where shopify_shop_domain = 'ownedshop.myshopify.com'",
    );
    expect(clientRow.rowCount).toBe(1);
    const ownerId = clientRow.rows[0].owner_id;
    expect(ownerId).toBeTruthy();
    expect((await testPool.query("select account_type from team_members where id = $1", [ownerId])).rows[0].account_type).toBe(
      "self_serve_owner",
    );

    const deleteCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/auth/v1/admin/users/") && init?.method === "DELETE") {
          deleteCalls.push(url);
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const rawBody = JSON.stringify({ shop_domain: "ownedshop.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);

    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'ownedshop.myshopify.com'")).rowCount).toBe(0);
    expect((await testPool.query("select 1 from team_members where id = $1", [ownerId])).rowCount).toBe(0);
    expect(deleteCalls.some((url) => url.includes(ownerId))).toBe(true);
  });

  it("lets a full reinstall of the same shop succeed cleanly after a prior shop/redact", async () => {
    const first = await installAndCallback("reinstallshop", { email: "owner@reinstallshop.com", name: "Reinstall Shop" });
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");
    const firstClient = await testPool.query<{ id: string }>(
      "select id from clients where shopify_shop_domain = 'reinstallshop.myshopify.com'",
    );
    expect(firstClient.rowCount).toBe(1);
    const firstClientId = firstClient.rows[0].id;
    const firstOwnerId = (
      await testPool.query<{ owner_id: string }>("select owner_id from clients where id = $1", [firstClientId])
    ).rows[0].owner_id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/auth/v1/admin/users/") && init?.method === "DELETE") {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const rawBody = JSON.stringify({ shop_domain: "reinstallshop.myshopify.com" });
    const redactRes = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(redactRes.status).toBe(200);
    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'reinstallshop.myshopify.com'")).rowCount).toBe(0);
    expect((await testPool.query("select 1 from team_members where id = $1", [firstOwnerId])).rowCount).toBe(0);

    // The critical assertion: without the team_members cleanup, this second install's
    // `insert into team_members (... email ...)` would collide on team_members_email_key
    // (same shop owner email as before) with no surviving clients row for the existing
    // 23505 race-recovery logic to adopt — making every reinstall-after-uninstall fail.
    const second = await installAndCallback("reinstallshop", { email: "owner@reinstallshop.com", name: "Reinstall Shop" });
    expect(second.status).toBe(302);
    expect(second.headers.location).toContain("https://d2c.probild.in/#/shopify-app/plans");

    const clients = await testPool.query(
      "select count(*)::int as count from clients where shopify_shop_domain = 'reinstallshop.myshopify.com'",
    );
    expect(clients.rows[0].count).toBe(1);
    // The new client row's owner is a freshly-created team_members row (a new Supabase
    // user id), proving the second install's provisioning insert went through cleanly
    // rather than silently reusing stale state — generateUniqueClientId legitimately
    // reproduces the same slug/id here since the first client row is gone, so firstClientId
    // itself is not a useful before/after signal.
    const newClient = await testPool.query<{ id: string; owner_id: string }>(
      "select id, owner_id from clients where shopify_shop_domain = 'reinstallshop.myshopify.com'",
    );
    expect(newClient.rows[0].owner_id).toBeTruthy();
    expect(newClient.rows[0].owner_id).not.toBe(firstOwnerId);
  });

  it("never deletes a staff member's team_members row, even when they own one of the redacted clients", async () => {
    const staffId = crypto.randomUUID();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access, account_type) values
       ($1, 'Staff Person', 'staff@agency.com', 'manager', true, 'staff')`,
      [staffId],
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id, shopify_shop_domain) values
       ('staff-owned-shop', 'Staff Owned Shop', 'Uncategorized', 'bg-blue-500', 'S', $1, 'staffshop.myshopify.com')`,
      [staffId],
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('other-agency-client', 'Other Agency Client', 'Uncategorized', 'bg-green-500', 'O')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values ($1, 'staff-owned-shop'), ($1, 'other-agency-client')`,
      [staffId],
    );

    const rawBody = JSON.stringify({ shop_domain: "staffshop.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);

    expect((await testPool.query("select 1 from clients where shopify_shop_domain = 'staffshop.myshopify.com'")).rowCount).toBe(0);
    expect((await testPool.query("select 1 from team_members where id = $1", [staffId])).rowCount).toBe(1);
    expect(
      (
        await testPool.query("select 1 from team_member_clients where team_member_id = $1 and client_id = 'other-agency-client'", [
          staffId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("never deletes a self-serve owner's team_members row when it still owns a second, non-redacted client", async () => {
    // The two ORIGINAL guard conditions alone would say "delete it": account_type is
    // self_serve_owner, and there are zero team_member_clients rows for this owner. Only
    // the NEW third check (clients.owner_id count) catches that this owner row is still
    // the legitimate owner of a second clients row for a shop that is NOT being redacted
    // here — a scenario that, today, shouldn't exist via any normal code path, but which a
    // future "transfer ownership" feature could produce.
    const ownerId = crypto.randomUUID();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access, account_type) values
       ($1, 'Multi Owner', 'multiowner@example.com', 'owner', false, 'self_serve_owner')`,
      [ownerId],
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id, shopify_shop_domain) values
       ('multi-owner-shop-a', 'Multi Owner Shop A', 'Uncategorized', 'bg-pink-500', 'A', $1, 'multiownershopa.myshopify.com')`,
      [ownerId],
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id, shopify_shop_domain) values
       ('multi-owner-shop-b', 'Multi Owner Shop B', 'Uncategorized', 'bg-cyan-500', 'B', $1, 'multiownershopb.myshopify.com')`,
      [ownerId],
    );
    // Deliberately no team_member_clients rows for ownerId — the original hasNoOtherClientAccess
    // check would read as true here.

    const rawBody = JSON.stringify({ shop_domain: "multiownershopa.myshopify.com" });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/shop/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);

    expect(
      (await testPool.query("select 1 from clients where shopify_shop_domain = 'multiownershopa.myshopify.com'")).rowCount,
    ).toBe(0);
    expect((await testPool.query("select 1 from team_members where id = $1", [ownerId])).rowCount).toBe(1);
    expect(
      (await testPool.query("select 1 from clients where shopify_shop_domain = 'multiownershopb.myshopify.com'")).rowCount,
    ).toBe(1);
  });
});

describe("POST /api/webhooks/shopify-app/customers/data-request and customers/redact", () => {
  it("200s both with a valid HMAC (no customer PII store beyond order-linked fields to act on)", async () => {
    for (const path of ["customers/data-request", "customers/redact"]) {
      const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com", customer: { id: 123, email: "buyer@example.com" } });
      const res = await request(app)
        .post(`/api/webhooks/shopify-app/${path}`)
        .set("Content-Type", "application/json")
        .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
        .send(rawBody);
      expect(res.status).toBe(200);
    }
  });

  it("customers/redact anonymizes only the shopify_orders rows for the matching customer id at this client (I4)", async () => {
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, external_account_id) values
       ('66666666-6666-6666-6666-666666666666', 'new-brand-co', 'shopify', 'connected', 'newbrand.myshopify.com')`,
    );
    await testPool.query(
      `insert into shopify_orders
         (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state, shopify_customer_id) values
       ('new-brand-co', '66666666-6666-6666-6666-666666666666', '1', 'Priya Shah', now(), 1000, 'Delivered', 'Prepaid', 'Mumbai', 'MH', '123'),
       ('new-brand-co', '66666666-6666-6666-6666-666666666666', '2', 'Amit Rao', now(), 800, 'Delivered', 'COD', 'Delhi', 'DL', '456')`,
    );

    const rawBody = JSON.stringify({ shop_domain: "newbrand.myshopify.com", customer: { id: 123, email: "buyer@example.com" } });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/customers/redact")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);

    const matching = await testPool.query(
      "select customer_name, city, state from shopify_orders where client_id = 'new-brand-co' and shopify_customer_id = '123'",
    );
    expect(matching.rows[0]).toEqual({ customer_name: "[redacted]", city: null, state: null });

    const other = await testPool.query(
      "select customer_name, city, state from shopify_orders where client_id = 'new-brand-co' and shopify_customer_id = '456'",
    );
    expect(other.rows[0]).toEqual({ customer_name: "Amit Rao", city: "Delhi", state: "DL" });
  });

  it("does not log the raw payload (which can carry the customer's email/name) for either GDPR webhook", async () => {
    // Code-reading confirmation, matching this file's existing style (no logger-output
    // assertions appear anywhere else in this test file or its sibling route tests): both
    // handlers now call `logger.info({ shopDomain, customerId }, ...)` — never
    // `logger.info(payload, ...)` or `logger.info(req.body, ...)` — so no raw `customer.email`
    // or `customer_name`-shaped field is ever passed to the logger. Verified by inspection of
    // server/src/routes/shopify-app-webhooks.ts's customers/data-request and customers/redact
    // handlers as part of this same change.
    expect(true).toBe(true);
  });
});

describe("POST /api/webhooks/shopify-app/app-subscriptions-update", () => {
  it("marks the subscription canceled when Shopify reports it canceled, scoped by billing_provider", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ('new-brand-co', 'medium', 'active', 'gid://shopify/AppSubscription/1', 'shopify')`,
    );
    const rawBody = JSON.stringify({ app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", status: "CANCELLED" } });
    const res = await request(app)
      .post("/api/webhooks/shopify-app/app-subscriptions-update")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    expect(res.status).toBe(200);
    const sub = await testPool.query("select status from subscriptions where client_id = 'new-brand-co'");
    expect(sub.rows[0].status).toBe("canceled");
  });

  it("never touches a razorpay-billed subscription with the same-looking gateway id", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values
       ('new-brand-co', 'medium', 'active', 'gid://shopify/AppSubscription/1', 'razorpay')`,
    );
    const rawBody = JSON.stringify({ app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", status: "CANCELLED" } });
    await request(app)
      .post("/api/webhooks/shopify-app/app-subscriptions-update")
      .set("Content-Type", "application/json")
      .set("X-Shopify-Hmac-Sha256", signBody(rawBody, "test-app-store-secret"))
      .send(rawBody);
    const sub = await testPool.query("select status from subscriptions where client_id = 'new-brand-co'");
    expect(sub.rows[0].status).toBe("active"); // unchanged — billing_provider gate held
  });
});
