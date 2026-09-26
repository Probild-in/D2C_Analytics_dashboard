import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { installFakeCourier, FAKE_COURIER_PLATFORM } from "../helpers/fake-courier.js";
import { signState } from "../../src/lib/state-token.js";

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
