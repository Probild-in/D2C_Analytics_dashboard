import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { googleConnector } from "../../src/integrations/google.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";

beforeEach(() => {
  process.env.GOOGLE_ADS_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "test-developer-token";
  process.env.PUBLIC_API_URL = "https://d2c.probild.in";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleConnector.getAuthUrl", () => {
  it("builds a Google OAuth consent URL requesting offline access and the adwords scope", () => {
    const url = googleConnector.getAuthUrl("abc-fashion", "signed-state-token");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/integrations/google/callback");
  });
});

describe("googleConnector.handleCallback", () => {
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
      `insert into subscriptions (client_id, plan_id, status, extra_google_accounts) values
       ('abc-fashion', 'starter', 'active', 0)`,
    );
  });

  it("exchanges the code for tokens and resolves the accessible customer id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "ya29.real-token", refresh_token: "1//real-refresh-token", expires_in: 3599 }), { status: 200 });
        }
        if (url.includes("listAccessibleCustomers")) {
          return new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const result = await googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" });
    expect(result.externalAccountId).toBe("1234567890");
    expect(result.accessToken).toBe("ya29.real-token");
    expect(result.refreshToken).toBe("1//real-refresh-token");
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("throws if the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid_grant", { status: 400 })));
    await expect(googleConnector.handleCallback({ code: "bad-code" }, { clientId: "abc-fashion" })).rejects.toThrow();
  });

  it("throws if no refresh_token is returned (user previously granted consent without prompt=consent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "ya29.real-token", expires_in: 3599 }), { status: 200 })),
    );
    await expect(googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/refresh token/i);
  });

  it("throws if no accessible customer is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "ya29.real-token", refresh_token: "1//real-refresh-token", expires_in: 3599 }), { status: 200 });
        }
        return new Response(JSON.stringify({ resourceNames: [] }), { status: 200 });
      }),
    );
    await expect(googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/customer/i);
  });

  it("throws when the client is already at its Google account limit", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, access_token, external_account_id) values
       ('abc-fashion', 'google', 'connected', 'x', '9999999999')`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "ya29.real-token", refresh_token: "1//real-refresh-token", expires_in: 3599 }), { status: 200 });
        }
        return new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), { status: 200 });
      }),
    );
    await expect(googleConnector.handleCallback({ code: "auth-code-123" }, { clientId: "abc-fashion" })).rejects.toThrow(/limit/i);
  });
});

describe("googleConnector token refresh", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  });

  it("refreshes an expired access token once and retries the request that triggered it", async () => {
    const { encryptToken } = await import("../../src/lib/crypto.js");
    await testPool.query(
      `insert into platform_connections (id, client_id, platform, status, access_token, refresh_token, external_account_id) values
       ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'google', 'connected', $1, $2, '1234567890')`,
      [encryptToken("stale-access-token"), encryptToken("1//real-refresh-token")],
    );

    let campaignsCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fresh-access-token", expires_in: 3599 }), { status: 200 });
        }
        if (url.includes("searchStream")) {
          campaignsCallCount++;
          const authHeader = (init?.headers as Record<string, string>)?.Authorization;
          if (authHeader === "Bearer stale-access-token") {
            return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), { status: 401 });
          }
          return new Response(JSON.stringify([{ results: [] }]), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const result = await googleConnector.sync("55555555-5555-5555-5555-555555555555");
    expect(result.recordsSynced).toBe(0);
    expect(campaignsCallCount).toBe(2); // first call 401s, second (post-refresh) succeeds

    const conn = await testPool.query("select access_token from platform_connections where id = $1", ["55555555-5555-5555-5555-555555555555"]);
    const { decryptToken } = await import("../../src/lib/crypto.js");
    expect(decryptToken(conn.rows[0].access_token)).toBe("fresh-access-token");
  });
});
