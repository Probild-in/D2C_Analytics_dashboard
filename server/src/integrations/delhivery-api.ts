// UNSOURCED: no Delhivery API documentation was confirmed by any tool available this
// session — Context7 returned only marketing overview text for the developer portal, and
// the docs site itself does not render for a non-browser fetch. Every URL, header, and
// field name below is a general, publicly-known convention about Delhivery's track-by-
// waybill API, presented here as an ASSUMPTION, never as documented fact. It is isolated
// to this file and parsed defensively (an unexpected shape throws, never silently
// produces wrong data) precisely so a wrong assumption is cheap to find and fix in one
// place. Confirm against a real Delhivery account or real documentation before relying on
// it — see the plan's Task 7 checklist.
const TRACK_URL = "https://track.delhivery.com/api/v1/packages/json/";

// Bad/expired token. Distinct from a transient failure so callers can ask the user to
// reconnect instead of retrying.
export class DelhiveryAuthError extends Error {}

export interface DelhiveryTrackedShipment {
  awb: string;
  status: string | null;
  statusType: string | null;
  destinationState: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Returns null when the AWB is simply not recognized by the API (an empty ShipmentData
// list) — that is a normal, expected outcome, not an error.
export async function trackShipment(token: string, awb: string): Promise<DelhiveryTrackedShipment | null> {
  const url = `${TRACK_URL}?waybill=${encodeURIComponent(awb)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new DelhiveryAuthError("Delhivery rejected the API token");
  }
  if (!res.ok) {
    throw new Error(`Delhivery track request failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.ShipmentData)) {
    throw new Error("Delhivery returned an unexpected tracking response (no ShipmentData array)");
  }
  if (body.ShipmentData.length === 0) return null;

  const entry = body.ShipmentData[0];
  const shipment = isRecord(entry) && isRecord(entry.Shipment) ? entry.Shipment : null;
  if (!shipment) {
    throw new Error("Delhivery returned an unexpected tracking response (no Shipment object)");
  }
  const status = isRecord(shipment.Status) ? shipment.Status : null;
  return {
    awb: asString(shipment.AWB) ?? awb,
    status: status ? asString(status.Status) : null,
    statusType: status ? asString(status.StatusType) : null,
    destinationState: asString(shipment.Destination),
  };
}
