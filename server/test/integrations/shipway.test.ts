import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { encryptToken } from "../../src/lib/crypto.js";
import { shipwayConnector, matchCarrier } from "../../src/integrations/shipway.js";
import { mapShipwayStatus } from "../../src/integrations/shipway-status.js";
import { CredentialsRejectedError } from "../../src/integrations/types.js";

const CONN = "99999999-9999-9999-9999-999999999999";
const SHOPIFY_CONN = "55555555-5555-5555-5555-555555555555";
const CREDS = { username: "acme", licenseKey: "lk-secret" };

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

async function insertConnection(credentials: object | null = CREDS) {
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, access_token, credentials, external_account_id)
     values ($1, 'abc-fashion', 'courier_shipway', 'connected', $2, $3, 'acme')`,
    [CONN, encryptToken(CREDS.licenseKey), credentials ? encryptToken(JSON.stringify(credentials)) : null],
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

// Routes Shipway's three POST endpoints by path; bodies are keyed by order_id for
// getOrderShipmentDetails.
function stubShipway(handlers: {
  carriers?: unknown;
  carriersStatus?: number;
  details?: (orderId: string) => unknown;
  push?: unknown;
}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
    if (url.endsWith("/carriers")) {
      return new Response(JSON.stringify(handlers.carriers ?? []), { status: handlers.carriersStatus ?? 200 });
    }
    if (url.endsWith("/getOrderShipmentDetails")) {
      const detail = handlers.details?.(body.order_id) ?? { status: "Failed" };
      return new Response(JSON.stringify(detail), { status: 200 });
    }
    if (url.endsWith("/pushOrderData")) {
      return new Response(JSON.stringify(handlers.push ?? { status: "success" }), { status: 200 });
    }
    throw new Error(`Unexpected Shipway URL in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("mapShipwayStatus", () => {
  it("maps the documented codes onto the shipment status model", () => {
    expect(mapShipwayStatus("DEL")).toBe("Delivered");
    expect(mapShipwayStatus("INT")).toBe("In Transit");
    expect(mapShipwayStatus("RTO")).toBe("RTO Initiated");
    expect(mapShipwayStatus("RTD")).toBe("RTO Delivered");
    expect(mapShipwayStatus("UND")).toBe("NDR");
    expect(mapShipwayStatus("CRTA")).toBe("NDR");
    expect(mapShipwayStatus("OOD")).toBe("Out for Delivery");
    expect(mapShipwayStatus("CAN")).toBe("Cancelled");
    expect(mapShipwayStatus("SCH")).toBe("Dispatched");
    expect(mapShipwayStatus("LOST")).toBeNull();
    expect(mapShipwayStatus("")).toBeNull();
    expect(mapShipwayStatus("no-such-code")).toBeNull();
  });
});

describe("matchCarrier", () => {
  const carriers = [
    { id: "1", name: "Blue Dart" },
    { id: "7", name: "Delhivery" },
  ];

  it("matches ignoring case, spacing and extra suffixes in either direction", () => {
    expect(matchCarrier("Delhivery Surface", carriers)).toEqual({ id: "7", name: "Delhivery" });
    expect(matchCarrier("bluedart", carriers)).toEqual({ id: "1", name: "Blue Dart" });
    expect(matchCarrier("DTDC", carriers)).toBeNull();
  });
});

describe("shipwayConnector.connectWithCredentials", () => {
  it("validates live against the carriers endpoint and stores both fields", async () => {
    stubShipway({ carriers: [{ id: "1", name: "Blue Dart" }] });
    const result = await shipwayConnector.connectWithCredentials("abc-fashion", {
      username: " acme ",
      licenseKey: " lk-secret ",
      evil: "drop me",
    });
    expect(result).toEqual({
      externalAccountId: "acme",
      accessToken: "lk-secret",
      credentials: { username: "acme", licenseKey: "lk-secret" },
    });
  });

  it("rejects when Shipway answers 401", async () => {
    stubShipway({ carriersStatus: 401 });
    await expect(
      shipwayConnector.connectWithCredentials("abc-fashion", { username: "acme", licenseKey: "wrong" }),
    ).rejects.toBeInstanceOf(CredentialsRejectedError);
  });

  it("rejects blank fields without calling Shipway", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      shipwayConnector.connectWithCredentials("abc-fashion", { username: "  ", licenseKey: "x" }),
    ).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shipwayConnector.sync", () => {
  it("upserts a shipment for an order Shipway already tracks", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("1001", "AWB1", "Blue Dart");
    stubShipway({
      details: (orderId) =>
        orderId === "1001"
          ? { status: "Success", response: { current_status_code: "RTO", current_status: "RTO in transit" } }
          : { status: "Failed" },
    });

    const result = await shipwayConnector.sync(CONN);
    expect(result.recordsSynced).toBe(1);

    const rows = await testPool.query("select awb, order_ref, status, courier_name from shipments where client_id = 'abc-fashion'");
    expect(rows.rows).toEqual([{ awb: "AWB1", order_ref: "1001", status: "RTO Initiated", courier_name: "Blue Dart" }]);
  });

  it("pushes an unknown order to Shipway using the matched carrier id, and skips unmatchable couriers", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("2001", "AWB2", "Delhivery Surface");
    await insertShopifyOrder("2002", "AWB3", "Some Unknown Courier");
    const fetchMock = stubShipway({
      carriers: [{ id: "7", name: "Delhivery" }],
      details: () => ({ status: "Failed" }),
    });

    const result = await shipwayConnector.sync(CONN);
    expect(result.recordsSynced).toBe(0);

    const pushCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/pushOrderData"));
    expect(pushCalls).toHaveLength(1);
    const pushed = JSON.parse(String((pushCalls[0][1] as RequestInit).body));
    expect(pushed).toMatchObject({ carrier_id: "7", awb: "AWB2", order_id: "2001", email: "N/A", phone: "N/A" });
  });

  it("fails with a reconnect message when Shipway rejects the stored credentials", async () => {
    await insertConnection();
    await insertShopifyConnection();
    await insertShopifyOrder("3001", "AWB4", "Blue Dart");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );

    await expect(shipwayConnector.sync(CONN)).rejects.toThrow(/reconnect/i);
  });

  it("updates last_synced_at after a successful run", async () => {
    await insertConnection();
    await insertShopifyConnection();
    stubShipway({ details: () => ({ status: "Failed" }) });

    await shipwayConnector.sync(CONN);
    const conn = await testPool.query("select last_synced_at from platform_connections where id = $1", [CONN]);
    expect(conn.rows[0].last_synced_at).not.toBeNull();
  });
});
