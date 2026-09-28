import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { decryptToken } from "../../src/lib/crypto.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubShiprocket(opts: { loginStatus?: number; orders?: unknown[] } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/auth/login")) {
        if (opts.loginStatus && opts.loginStatus !== 200) return new Response("{}", { status: opts.loginStatus });
        return new Response(JSON.stringify({ token: "fresh-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: opts.orders ?? [] }), { status: 200 });
    }),
  );
}

const connect = (credentials: unknown) =>
  request(app)
    .post("/api/clients/abc-fashion/connections/courier_shiprocket/connect")
    .set("Authorization", `Bearer ${token()}`)
    .send({ credentials });

describe("connecting Shiprocket end to end", () => {
  it("connects, stores only email + password encrypted, then a manual sync writes shipments", async () => {
    stubShiprocket({
      orders: [
        {
          id: 1001,
          channel_order_id: "1001",
          status: "IN TRANSIT",
          customer_state: "Karnataka",
          created_at: new Date().toISOString(),
          shipments: [{ awb: "AWB1", courier: "Delhivery" }],
        },
      ],
    });

    const res = await connect({ email: "Ops@ABC.com", password: "pw-secret", extra: "drop me" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "courier_shiprocket", status: "connected", externalAccountId: "ops@abc.com" });

    const row = (await testPool.query("select access_token, credentials from platform_connections")).rows[0];
    expect(decryptToken(row.access_token)).toBe("fresh-token");
    expect(JSON.parse(decryptToken(row.credentials))).toEqual({ email: "ops@abc.com", password: "pw-secret" });
    expect(row.credentials).not.toContain("pw-secret");

    const sync = await request(app)
      .post("/api/clients/abc-fashion/connections/courier_shiprocket/sync")
      .set("Authorization", `Bearer ${token()}`);
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ recordsSynced: 1 });
    expect((await testPool.query("select awb, status, courier_name from shipments")).rows).toEqual([
      { awb: "AWB1", status: "In Transit", courier_name: "Delhivery" },
    ]);
  });

  it("returns a 400 with Shiprocket's rejection message and creates nothing when the login is refused", async () => {
    stubShiprocket({ loginStatus: 403 });
    const res = await connect({ email: "ops@abc.com", password: "wrong" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("credentials_rejected");
    expect(res.body.error.message).toContain("Shiprocket rejected");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("returns a generic 502 when Shiprocket itself is failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubShiprocket({ loginStatus: 500 });
    const res = await connect({ email: "ops@abc.com", password: "pw" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("provider_unreachable");
  });
});
