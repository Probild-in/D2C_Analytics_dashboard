import { describe, it, expect, vi, afterEach } from "vitest";
import { trackShipment, DelhiveryAuthError } from "../../src/integrations/delhivery-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// UNSOURCED response shape (see delhivery-api.ts header comment) — this fixture is this
// module's own assumption about what track-by-waybill returns, not a documented sample.
const TRACK_FIXTURE = {
  ShipmentData: [
    {
      Shipment: {
        AWB: "AWB123",
        Status: { Status: "In Transit", StatusType: "UD" },
        Destination: "Maharashtra",
      },
    },
  ],
};

describe("trackShipment", () => {
  it("sends the token as an Authorization header and parses the response", async () => {
    const fetchMock = stubFetch(TRACK_FIXTURE);
    const result = await trackShipment("tok-1", "AWB123");
    expect(result).toEqual({ awb: "AWB123", status: "In Transit", statusType: "UD", destinationState: "Maharashtra" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("AWB123");
    expect((init.headers as Record<string, string>).Authorization).toContain("tok-1");
  });

  it("returns null when the shipment list is empty (AWB not found)", async () => {
    stubFetch({ ShipmentData: [] });
    expect(await trackShipment("tok-1", "UNKNOWN")).toBeNull();
  });

  it("throws DelhiveryAuthError on 401", async () => {
    stubFetch({}, 401);
    await expect(trackShipment("bad-token", "AWB123")).rejects.toBeInstanceOf(DelhiveryAuthError);
  });

  it("throws a plain error on a server failure", async () => {
    stubFetch({}, 500);
    const err = await trackShipment("tok-1", "AWB123").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DelhiveryAuthError);
  });

  it("throws on an unexpected response shape rather than guessing", async () => {
    stubFetch({ unexpected: true });
    await expect(trackShipment("tok-1", "AWB123")).rejects.toThrow(/unexpected/i);
  });

  it("tolerates a missing Status or Destination without throwing", async () => {
    stubFetch({ ShipmentData: [{ Shipment: { AWB: "AWB999" } }] });
    expect(await trackShipment("tok-1", "AWB999")).toEqual({
      awb: "AWB999",
      status: null,
      statusType: null,
      destinationState: null,
    });
  });
});
