import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { installFakeCourier, FAKE_COURIER_PLATFORM } from "../helpers/fake-courier.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
let restore: () => void;

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
  restore = installFakeCourier();
});

afterEach(() => restore());

describe("connect rate limiting", () => {
  it("returns 429 after 10 attempts in the window", async () => {
    const token = signTestJwt({ sub: RIYA, email: "riya@agency.com" });
    const attempt = () =>
      request(app)
        .post(`/api/clients/abc-fashion/connections/${FAKE_COURIER_PLATFORM}/connect`)
        .set("Authorization", `Bearer ${token}`)
        .send({ credentials: { email: "ops@abc.com", password: "x" } });

    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status).toBe(200);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});
