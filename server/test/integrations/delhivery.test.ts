import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";
import { delhiveryConnector } from "../../src/integrations/delhivery.js";
import { CredentialsRejectedError } from "../../src/integrations/types.js";

const CONN = "88888888-8888-8888-8888-888888888888";
const SHOPIFY_CONN = "55555555-5555-5555-5555-555555555555";
const TOKEN = "tok-secret";

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

async function insertConnection(status = "connected", credentials: object | null = { token: TOKEN }) {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, credentials, external_account_id)
     values ($1, 'abc-fashion', 'courier_delhivery', $2, $3, $4, 'delhivery-token')`,
    [CONN, status, encryptToken(TOKEN), credentials ? encryptToken(JSON.stringify(credentials)) : null],
  );
}

async function insertShopifyConnection() {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('${SHOPIFY_CONN}', 'abc-fashion', 'shopify', 'connected', 'abc-fashion.myshopify.com')`,
  );
}

async function insertShopifyOrder(orderId: string, trackingNumber: string | null, trackingCompany: string | null) {
  await testPool.query(
    `insert into shopify_orders
       (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, tracking_number, tracking_company)
     values ('abc-fashion', '${SHOPIFY_CONN}', $1, 'Priya Shah', now(), 1000, 'Dispatched', 'Prepaid', $2, $3)`,
    [orderId, trackingNumber, trackingCompany],
  );
}

function stubDelhivery(responses: Record<string, unknown> | ((awb: string) => unknown), status = 200) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const awb = new URL(url).searchParams.get("waybill") ?? "";
    const body = typeof responses === "function" ? responses(awb) : (responses[awb] ?? { ShipmentData: [] });
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("delhiveryConnector.connectWithCredentials", () => {
  it("accepts a non-blank token without calling Delhivery live", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await delhiveryConnector.connectWithCredentials("abc-fashion", { token: "  my-token  ", evil: "drop me" });
    expect(result).toEqual({ externalAccountId: "delhivery-token", accessToken: "my-token", credentials: { token: "my-token" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a blank token", async () => {
    await expect(delhiveryConnector.connectWithCredentials("abc-fashion", { token: "   " })).rejects.toBeInstanceOf(
      CredentialsRejectedError,
    );
  });
});

describe("delhiveryConnector.sync", () => {
  it("tracks Shopify orders whose tracking company mentions Delhivery and upserts shipments", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    await insertShopifyOrder("1002", "AWB2", "delhivery air");
    await insertShopifyOrder("1003", "TRACK3", "Bluedart"); // not Delhivery — must be ignored
    await insertShopifyOrder("1004", null, null); // no tracking — must be ignored

    stubDelhivery({
      AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered", StatusType: "DL" }, Destination: "Maharashtra" } }] },
      AWB2: { ShipmentData: [{ Shipment: { AWB: "AWB2", Status: { Status: "In Transit", StatusType: "UD" }, Destination: "Karnataka" } }] },
    });

    const result = await delhiveryConnector.sync(CONN);
    expect(result).toEqual({ recordsSynced: 2 });

    const rows = (
      await testPool.query("select awb, status, courier_name, destination_state from shipments order by awb")
    ).rows;
    expect(rows).toEqual([
      { awb: "AWB1", status: "Delivered", courier_name: "Delhivery", destination_state: "Maharashtra" },
      { awb: "AWB2", status: "In Transit", courier_name: "Delhivery", destination_state: "Karnataka" },
    ]);
    const conn = (await testPool.query("select status, last_synced_at from platform_connections where id = $1", [CONN])).rows[0];
    expect(conn.status).toBe("connected");
    expect(conn.last_synced_at).not.toBeNull();
  });

  it("is idempotent and updates status on the next run", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");

    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "In Transit" } } }] } });
    await delhiveryConnector.sync(CONN);
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered" } } }] } });
    await delhiveryConnector.sync(CONN);

    expect((await testPool.query("select status from shipments")).rows).toEqual([{ status: "Delivered" }]);
  });

  it("skips a shipment already terminal, without calling Delhivery for it again", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    await testPool.query(
      `insert into shipments (client_id, connection_id, awb, courier_name, status, ordered_at) values
       ('abc-fashion', '${CONN}', 'AWB1', 'Delhivery', 'Delivered', now())`,
    );
    const fetchMock = stubDelhivery({});
    await delhiveryConnector.sync(CONN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the AWB unaltered when Delhivery finds nothing for it (still marks synced)", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({}); // empty ShipmentData for every AWB
    const result = await delhiveryConnector.sync(CONN);
    expect(result).toEqual({ recordsSynced: 0 });
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });

  it("falls back to In Transit and warns once for an unrecognized status label", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Something Unexpected" } } }] } });
    await delhiveryConnector.sync(CONN);
    expect((await testPool.query("select status from shipments")).rows).toEqual([{ status: "In Transit" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Something Unexpected");
  });

  it("fails clearly and writes nothing when the stored token is rejected", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({}, 401);
    await expect(delhiveryConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
    expect((await testPool.query("select 1 from shipments")).rowCount).toBe(0);
  });

  it("fails when the connection has no stored credentials", async () => {
    await insertConnection("connected", null);
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    await expect(delhiveryConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
  });

  it("does not resurrect a disconnected connection", async () => {
    await insertConnection("disconnected");
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered" } } }] } });
    await delhiveryConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections where id = $1", [CONN])).rows[0].status).toBe(
      "disconnected",
    );
  });

  it("recovers a connection stuck in error", async () => {
    await insertConnection("error");
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Delhivery Surface");
    stubDelhivery({ AWB1: { ShipmentData: [{ Shipment: { AWB: "AWB1", Status: { Status: "Delivered" } } }] } });
    await delhiveryConnector.sync(CONN);
    expect((await testPool.query("select status from platform_connections where id = $1", [CONN])).rows[0].status).toBe(
      "connected",
    );
  });
});

describe("delhiveryConnector.disconnect", () => {
  it("marks the connection disconnected", async () => {
    await insertConnection();
    await delhiveryConnector.disconnect(CONN);
    expect((await testPool.query("select status from platform_connections")).rows[0].status).toBe("disconnected");
  });
});
