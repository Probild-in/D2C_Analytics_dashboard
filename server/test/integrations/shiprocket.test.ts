import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";
import { shiprocketConnector } from "../../src/integrations/shiprocket.js";
import { CredentialsRejectedError } from "../../src/integrations/types.js";

const CONN = "66666666-6666-6666-6666-666666666666";
const CREDS = { email: "ops@abc.com", password: "pw-secret" };
const DAY = 24 * 60 * 60 * 1000;
const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function insertConnection(status = "connected", creds: object | null = CREDS) {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, credentials, external_account_id)
     values ($1, 'abc-fashion', 'courier_shiprocket', $2, $3, $4, 'ops@abc.com')`,
    [CONN, status, encryptToken("old-token"), creds ? encryptToken(JSON.stringify(creds)) : null],
  );
}

// pages[i] is the JSON body returned for `page=i+1`; a missing page returns an empty list.
function stubShiprocket(pages: unknown[], opts: { loginStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/auth/login")) {
      if (opts.loginStatus && opts.loginStatus !== 200) return new Response("{}", { status: opts.loginStatus });
      return new Response(JSON.stringify({ token: "fresh-token" }), { status: 200 });
    }
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(pages[page - 1] ?? { data: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const order = (ref: string, status: string, shipments: unknown[], createdAt = recent(2), state: string | null = "Maharashtra") => ({
  id: Number(ref),
  channel_order_id: ref,
  status,
  customer_state: state,
  created_at: createdAt,
  shipments,
});

describe("shiprocketConnector.connectWithCredentials", () => {
  it("logs in, lowercases the email and stores only email + password", async () => {
    const fetchMock = stubShiprocket([]);
    const result = await shiprocketConnector.connectWithCredentials("abc-fashion", {
      email: "  Ops@ABC.com ",
      password: "pw-secret",
      evil: "should be dropped",
    });
    expect(result).toEqual({
      externalAccountId: "ops@abc.com",
      accessToken: "fresh-token",
      credentials: { email: "ops@abc.com", password: "pw-secret" },
    });
    const loginBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(loginBody).toEqual({ email: "ops@abc.com", password: "pw-secret" });
  });

  it("rejects a blank email or password without calling Shiprocket", async () => {
    const fetchMock = stubShiprocket([]);
    await expect(shiprocketConnector.connectWithCredentials("abc-fashion", { email: "", password: "" })).rejects.toBeInstanceOf(
      CredentialsRejectedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a rejected login into a user-facing CredentialsRejectedError", async () => {
    stubShiprocket([], { loginStatus: 403 });
    const err = await shiprocketConnector.connectWithCredentials("abc-fashion", CREDS).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err.message).toContain("API user");
  });

  it("lets non-auth failures through as ordinary errors", async () => {
    stubShiprocket([], { loginStatus: 500 });
    const err = await shiprocketConnector.connectWithCredentials("abc-fashion", CREDS).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CredentialsRejectedError);
  });
});

describe("shiprocketConnector.sync", () => {
  it("upserts one shipment per AWB across pages and skips orders without shipments", async () => {
    await insertConnection();
    stubShiprocket([
      {
        data: [
          order("1001", "DELIVERED", [{ awb: "AWB1", courier: "Delhivery", status: "DELIVERED", delivered_date: recent(1) }]),
          order("1002", "NEW", []),
        ],
        meta: { pagination: { total_pages: 2 } },
      },
      { data: [order("1003", "RTO INITIATED", [{ awb: "AWB3", courier: "Bluedart", status: "RTO INITIATED" }], recent(3), "Delhi")] },
    ]);

    const result = await shiprocketConnector.sync(CONN);

    expect(result).toEqual({ recordsSynced: 2 });
    const rows = (
      await testPool.query(
        "select awb, order_ref, courier_name, status, destination_state, ordered_at is not null as has_ordered, delivered_at is not null as has_delivered from shipments order by awb",
      )
    ).rows;
    expect(rows).toEqual([
      { awb: "AWB1", order_ref: "1001", courier_name: "Delhivery", status: "Delivered", destination_state: "Maharashtra", has_ordered: true, has_delivered: true },
      { awb: "AWB3", order_ref: "1003", courier_name: "Bluedart", status: "RTO Initiated", destination_state: "Delhi", has_ordered: true, has_delivered: false },
    ]);
    const conn = (await testPool.query("select status, last_synced_at from platform_connections")).rows[0];
    expect(conn.status).toBe("connected");
    expect(conn.last_synced_at).not.toBeNull();
  });

  it("is idempotent and updates a shipment's status on the next run", async () => {
    await insertConnection();
    stubShiprocket([{ data: [order("1001", "IN TRANSIT", [{ awb: "AWB1", courier: "Delhivery" }])] }]);
    await shiprocketConnector.sync(CONN);
    stubShiprocket([{ data: [order("1001", "DELIVERED", [{ awb: "AWB1", courier: "Delhivery" }])] }]);
    await shiprocketConnector.sync(CONN);

    const rows = (await testPool.query("select awb, status from shipments")).rows;
    expect(rows).toEqual([{ awb: "AWB1", status: "Delivered" }]);
  });

  it("logs in with the stored credentials at the start of every sync", async () => {
    await insertConnection();
    const fetchMock = stubShiprocket([{ data: [] }]);
    await shiprocketConnector.sync(CONN);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/auth/login");
    expect(JSON.parse(init.body as string)).toEqual(CREDS);
    const ordersCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((ordersCall[1].headers as Record<string, string>).Authorization).toBe("Bearer fresh-token");
  });

  it("stops paging once a whole page is older than the 30 day window", async () => {
    await insertConnection();
    const old = recent(90);
    const fetchMock = stubShiprocket([
      { data: [order("900", "DELIVERED", [{ awb: "OLD1", courier: "Delhivery" }], old)], meta: { pagination: { total_pages: 5 } } },
    ]);
    await shiprocketConnector.sync(CONN);
    // one login + exactly one orders page
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails clearly, and writes nothing, when the stored credentials are rejected", async () => {
    await insertConnection();
    stubShiprocket([], { loginStatus: 403 });
    await expect(shiprocketConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });

  it("fails when the connection has no stored credentials", async () => {
    await insertConnection("connected", null);
    stubShiprocket([]);
    await expect(shiprocketConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
  });

  it("falls back to In Transit and warns for an unrecognized status label", async () => {
    await insertConnection();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubShiprocket([{ data: [order("1001", "SOMETHING NEW", [{ awb: "AWB1", courier: "Delhivery" }])] }]);
    await shiprocketConnector.sync(CONN);
    expect((await testPool.query("select status from shipments")).rows).toEqual([{ status: "In Transit" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("SOMETHING NEW");
  });

  it("does not resurrect a disconnected connection", async () => {
    await insertConnection("disconnected");
    stubShiprocket([{ data: [] }]);
    await shiprocketConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("disconnected");
  });

  it("recovers a connection stuck in error", async () => {
    await insertConnection("error");
    stubShiprocket([{ data: [] }]);
    await shiprocketConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("connected");
  });
});

describe("shiprocketConnector.disconnect", () => {
  it("marks the connection disconnected", async () => {
    await insertConnection();
    await shiprocketConnector.disconnect(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("disconnected");
  });
});
