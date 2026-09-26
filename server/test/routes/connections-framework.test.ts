import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { installFakeCourier, FAKE_COURIER_PLATFORM } from "../helpers/fake-courier.js";
import { signState } from "../../src/lib/state-token.js";
import { decryptToken } from "../../src/lib/crypto.js";
import { CredentialsRejectedError } from "../../src/integrations/types.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
let restoreFakeCourier: () => void;

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
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
  process.env.FRONTEND_URL = "https://d2c.probild.in";
  restoreFakeCourier = installFakeCourier();
});

afterEach(() => {
  restoreFakeCourier();
});

describe("authType guards", () => {
  it("rejects /authorize for a credentials-type platform", async () => {
    const token = signTestJwt({ sub: RIYA, email: "riya@agency.com" });
    const res = await request(app)
      .post(`/api/clients/abc-fashion/connections/${FAKE_COURIER_PLATFORM}/authorize`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("wrong_auth_type");
  });

  it("rejects the OAuth callback for a credentials-type platform", async () => {
    const state = await signState({ clientId: "abc-fashion", platform: FAKE_COURIER_PLATFORM, teamMemberId: RIYA });
    const res = await request(app)
      .get(`/api/integrations/${FAKE_COURIER_PLATFORM}/callback`)
      .query({ state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connection=error");
    // The guard's own message, not the generic catch-all one (URLSearchParams encodes spaces as "+").
    const message = new URL(res.headers.location.replace("/#/", "/?")).searchParams.get("message");
    expect(message).toBe("This platform does not use OAuth");
  });
});

const CREDS = { email: "ops@abc.com", password: "hunter2-secret" };

describe("POST /api/clients/:id/connections/:platform/connect", () => {
  const post = (platform: string, body: unknown, sub = RIYA, email = "riya@agency.com") =>
    request(app)
      .post(`/api/clients/abc-fashion/connections/${platform}/connect`)
      .set("Authorization", `Bearer ${signTestJwt({ sub, email })}`)
      .send(body as object);

  it("connects with valid credentials and stores them encrypted", async () => {
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      platform: FAKE_COURIER_PLATFORM,
      status: "connected",
      externalAccountId: "ops@abc.com",
    });

    const row = (await testPool.query("select access_token, credentials, status, connected_by from platform_connections")).rows[0];
    expect(row.status).toBe("connected");
    expect(row.connected_by).toBe(RIYA);
    expect(decryptToken(row.access_token)).toBe("fake-token");
    expect(row.credentials).not.toContain("hunter2-secret");
    expect(JSON.parse(decryptToken(row.credentials))).toEqual(CREDS);
  });

  it("never returns secrets from the connections list", async () => {
    await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    const list = await request(app)
      .get("/api/clients/abc-fashion/connections")
      .set("Authorization", `Bearer ${signTestJwt({ sub: RIYA, email: "riya@agency.com" })}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("hunter2-secret");
    expect(JSON.stringify(list.body)).not.toContain("fake-token");
  });

  it("404s for an unknown platform", async () => {
    const res = await post("not_a_platform", { credentials: CREDS });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_platform");
  });

  it("400s for an OAuth-type platform", async () => {
    const res = await post("shopify", { credentials: CREDS });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("wrong_auth_type");
  });

  it("400s when credentials is missing or not a string map", async () => {
    const missing = await post(FAKE_COURIER_PLATFORM, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_credentials_payload");
    const wrongShape = await post(FAKE_COURIER_PLATFORM, { credentials: { email: 42 } });
    expect(wrongShape.status).toBe(400);
    expect(wrongShape.body.error.code).toBe("invalid_credentials_payload");
  });

  it("returns the provider's message as a 400 and creates no connection when credentials are rejected", async () => {
    restoreFakeCourier();
    restoreFakeCourier = installFakeCourier({
      async connectWithCredentials() {
        throw new CredentialsRejectedError("Shiprocket rejected these credentials");
      },
    });
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "credentials_rejected", message: "Shiprocket rejected these credentials" });
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("returns a generic 502 without leaking internals on unexpected failures", async () => {
    restoreFakeCourier();
    restoreFakeCourier = installFakeCourier({
      async connectWithCredentials() {
        throw new Error("connect ECONNREFUSED 10.0.0.5:443 secret-internal-detail");
      },
    });
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("provider_unreachable");
    expect(JSON.stringify(res.body)).not.toContain("secret-internal-detail");
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const res = await post(FAKE_COURIER_PLATFORM, { credentials: CREDS }, "22222222-2222-2222-2222-222222222222", "scoped@agency.com");
    expect(res.status).toBe(404);
  });

  it("reconnecting the same account updates the row instead of duplicating it", async () => {
    await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    await post(FAKE_COURIER_PLATFORM, { credentials: CREDS });
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(1);
  });
});

describe("DELETE /api/clients/:id/connections/:platform", () => {
  const del = (platform: string, sub = RIYA, email = "riya@agency.com") =>
    request(app)
      .delete(`/api/clients/abc-fashion/connections/${platform}`)
      .set("Authorization", `Bearer ${signTestJwt({ sub, email })}`);

  beforeEach(async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id) values
       ('abc-fashion', '${FAKE_COURIER_PLATFORM}', 'connected', 'ops@abc.com')`,
    );
  });

  it("disconnects the platform for the client and keeps the row", async () => {
    const res = await del(FAKE_COURIER_PLATFORM);
    expect(res.status).toBe(204);
    const rows = (await testPool.query("select status from platform_connections")).rows;
    expect(rows).toEqual([{ status: "disconnected" }]);
  });

  it("404s not_connected when there is nothing to disconnect", async () => {
    await del(FAKE_COURIER_PLATFORM);
    const again = await del(FAKE_COURIER_PLATFORM);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("not_connected");
  });

  it("404s for an unknown platform", async () => {
    const res = await del("not_a_platform");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_platform");
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const res = await del(FAKE_COURIER_PLATFORM, "22222222-2222-2222-2222-222222222222", "scoped@agency.com");
    expect(res.status).toBe(404);
  });
});
