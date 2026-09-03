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
