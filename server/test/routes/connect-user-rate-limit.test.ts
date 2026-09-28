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
  for (const id of ["c1", "c2", "c3", "c4"]) {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values ($1, $1, 'Fashion', 'bg-violet-500', 'A')`,
      [id],
    );
  }
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  restore = installFakeCourier();
});

afterEach(() => restore());

describe("connect per-user rate limiting", () => {
  it("blocks a user after 30 attempts in the window even across different clients", async () => {
    const token = signTestJwt({ sub: RIYA, email: "riya@agency.com" });
    const attempt = (clientId: string) =>
      request(app)
        .post(`/api/clients/${clientId}/connections/${FAKE_COURIER_PLATFORM}/connect`)
        .set("Authorization", `Bearer ${token}`)
        .send({ credentials: { email: "ops@abc.com", password: "x" } });

    for (const clientId of ["c1", "c2", "c3"]) {
      for (let i = 0; i < 10; i++) {
        expect((await attempt(clientId)).status).toBe(200);
      }
    }
    const blocked = await attempt("c4");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
  });
});
