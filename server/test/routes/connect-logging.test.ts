import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  // An error whose own properties carry the request body, like an HTTP client error might.
  restore = installFakeCourier({
    async connectWithCredentials() {
      throw Object.assign(new Error("ECONNREFUSED"), {
        request: { body: { email: "ops@abc.com", password: "hunter2-secret" } },
      });
    },
  });
});

afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("POST /connect logging", () => {
  it("logs only the error message, never the error object", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/clients/abc-fashion/connections/${FAKE_COURIER_PLATFORM}/connect`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: RIYA, email: "riya@agency.com" })}`)
      .send({ credentials: { email: "ops@abc.com", password: "hunter2-secret" } });

    expect(res.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0].map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("hunter2-secret");
  });
});
