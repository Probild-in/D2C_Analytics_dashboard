import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { metaConnector } from "../../src/integrations/meta.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

beforeEach(() => {
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("metaConnector.getAuthUrl", () => {
  it("builds a Facebook Login dialog URL with ads_read scope", () => {
    const url = metaConnector.getAuthUrl("abc-fashion", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.facebook.com");
    expect(parsed.pathname).toBe("/v21.0/dialog/oauth");
    expect(parsed.searchParams.get("client_id")).toBe("test-app-id");
    expect(parsed.searchParams.get("scope")).toBe("ads_read");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/meta/callback");
  });
});

describe("metaConnector.handleCallback", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into plans (id, name, monthly_fee_inr, included_meta_accounts, included_google_accounts) values
       ('starter', 'Starter', 5000, 1, 1)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, extra_meta_accounts) values
       ('abc-fashion', 'starter', 'active', 0)`,
    );
  });

  it("exchanges the code for an access token and resolves the ad account id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "fb-real-token", token_type: "bearer", expires_in: 5184000 }), { status: 200 });
        }
        if (url.includes("/me/adaccounts")) {
          return new Response(JSON.stringify({ data: [{ id: "act_123456789", name: "ABC Fashion Ads" }] }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const result = await metaConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" });
    expect(result.externalAccountId).toBe("act_123456789");
    expect(result.accessToken).toBe("fb-real-token");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid request", { status: 400 })));
    await expect(metaConnector.handleCallback({ code: "bad-code" }, { clientId: "abc-fashion" })).rejects.toThrow();
  });

  it("throws if the account has no ad accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "fb-real-token", expires_in: 5184000 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    await expect(metaConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/ad account/i);
  });

  it("throws when the client is already at its Meta account limit", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, access_token, external_account_id) values
       ('abc-fashion', 'meta', 'connected', 'x', 'act_existing')`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "fb-real-token", expires_in: 5184000 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: "act_new", name: "New Account" }] }), { status: 200 });
      }),
    );
    await expect(metaConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/limit/i);
  });
});

describe("metaConnector.sync", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    const { encryptToken } = await import("../../src/lib/crypto.js");
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'meta', 'connected', $1, 'act_123456789')`,
      [encryptToken("fb-real-token")],
    );
  });

  it("upserts campaigns, daily insights, and creatives from the Marketing API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/campaigns?")) {
          return new Response(
            JSON.stringify({ data: [{ id: "camp_1", name: "Diwali Sale", status: "ACTIVE" }] }),
            { status: 200 },
          );
        }
        if (url.includes("camp_1/insights?")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  campaign_id: "camp_1",
                  campaign_name: "Diwali Sale",
                  date_start: "2026-09-01",
                  spend: "499.50",
                  impressions: "10000",
                  clicks: "250",
                  actions: [{ action_type: "omni_purchase", value: "12" }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/ads?")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "ad_1",
                  name: "Diwali Carousel",
                  campaign_id: "camp_1",
                  status: "ACTIVE",
                  created_time: "2026-08-15T00:00:00+0000",
                  creative: {
                    id: "creative_1",
                    object_type: "CAROUSEL",
                    title: "50% Off Everything",
                    body: "Shop the Diwali sale now",
                    call_to_action_type: "SHOP_NOW",
                    thumbnail_url: "https://scontent.example.com/creative_1.jpg",
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("ad_1/insights?")) {
          return new Response(
            JSON.stringify({ data: [{ spend: "120.00", impressions: "3000", clicks: "80", actions: [{ action_type: "omni_purchase", value: "4" }] }] }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await metaConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(1);

    const campaigns = await testPool.query("select * from campaigns where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(campaigns.rowCount).toBe(1);
    expect(campaigns.rows[0]).toMatchObject({ external_campaign_id: "camp_1", name: "Diwali Sale", status: "active" });

    const metrics = await testPool.query("select * from meta_campaign_metrics where connection_id = $1", ["55555555-5555-5555-5555-555555555555"]);
    expect(metrics.rowCount).toBe(1);
    expect(metrics.rows[0]).toMatchObject({ campaign_id: "camp_1", spend: 500, impressions: 10000, clicks: 250, results: 12 });

    const creatives = await testPool.query(
      "select * from campaign_creatives where campaign_id = $1",
      [campaigns.rows[0].id],
    );
    expect(creatives.rowCount).toBe(1);
    expect(creatives.rows[0]).toMatchObject({
      external_creative_id: "creative_1",
      name: "Diwali Carousel",
      format: "CAROUSEL",
      headline: "50% Off Everything",
      cta: "SHOP_NOW",
      thumbnail_url: "https://scontent.example.com/creative_1.jpg",
      status: "active",
      spend: 120,
      impressions: 3000,
      clicks: 80,
      results: 4,
    });
  });

  it("updates last_synced_at and resets status to connected on the connection", async () => {
    await testPool.query("update platform_connections set status = 'error' where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    await metaConnector.sync("55555555-5555-5555-5555-555555555555");
    const conn = await testPool.query("select last_synced_at, status from platform_connections where id = $1", [
      "55555555-5555-5555-5555-555555555555",
    ]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
    expect(conn.rows[0].status).toBe("connected");
  });
});
