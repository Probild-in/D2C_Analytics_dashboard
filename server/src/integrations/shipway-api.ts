// Shipway API v3.1.2 (shipway.in) — documented in "Shipway_Docs_for_client_v_1.3.pdf",
// the official client doc. Auth is username + licence key in each POST body; HTTP 401
// means bad credentials. Workflow: an order must be pushed once (pushOrderData, with a
// Shipway carrier_id) before getOrderShipmentDetails can track it.
export class ShipwayAuthError extends Error {}

const BASE_URL = "https://shipway.in/api";

export interface ShipwayCarrier {
  id: string;
  name: string;
}

export interface ShipwayTrackedShipment {
  statusCode: string;
  statusText: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function post(path: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ShipwayAuthError("Shipway rejected the username/licence key");
  }
  if (!res.ok) {
    throw new Error(`Shipway ${path} request failed: ${res.status}`);
  }
  // Observed live: Shipway answers 200 with a COMPLETELY EMPTY body (Content-Length: 0)
  // for an unknown order_id and for a rejected push — that's their "no", not an outage.
  // Treat empty/unparseable as null; each caller already handles null as "nothing here".
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// Doubles as the live credentials check at connect time (Shipway, unlike Delhivery, has
// this cheap authenticated endpoint). The docs don't show the response shape, so carrier
// entries are parsed defensively from wherever an array shows up; an empty list is still
// a successful auth.
export async function getCarriers(username: string, licenseKey: string): Promise<ShipwayCarrier[]> {
  const body = await post("carriers", { username, password: licenseKey });
  // Observed live: the real response is {"status":"success","couriers":[{id, courier_name,
  // image}, ...]} — "couriers", not "carriers" as the doc's method name suggests.
  const list = Array.isArray(body)
    ? body
    : isRecord(body)
      ? [body.couriers, body.response, body.carriers, body.data].find(Array.isArray) ?? []
      : [];
  const carriers: ShipwayCarrier[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = entry.id ?? entry.carrier_id;
    const name = entry.name ?? entry.carrier_name ?? entry.carrier;
    if ((typeof id === "string" || typeof id === "number") && typeof name === "string" && name.trim()) {
      carriers.push({ id: String(id), name: name.trim() });
    }
  }
  return carriers;
}

// Returns null when Shipway doesn't know the order (not pushed yet, or still awaiting
// first scan) — a normal outcome, not an error.
export async function getOrderShipmentDetails(
  username: string,
  licenseKey: string,
  orderId: string,
): Promise<ShipwayTrackedShipment | null> {
  const body = await post("getOrderShipmentDetails", { username, password: licenseKey, order_id: orderId });
  if (!isRecord(body) || String(body.status ?? "").toLowerCase() !== "success") return null;
  const response = isRecord(body.response) ? body.response : null;
  if (!response || typeof response.current_status_code !== "string" || !response.current_status_code.trim()) {
    return null;
  }
  return {
    statusCode: response.current_status_code.trim(),
    statusText: typeof response.current_status === "string" ? response.current_status : null,
  };
}

export async function pushOrderData(
  username: string,
  licenseKey: string,
  order: { carrierId: string; awb: string; orderId: string },
): Promise<boolean> {
  // The contact fields are mandatory but the docs explicitly allow "N/A". Sent as N/A on
  // purpose: Shipway emails/SMSes pushed customers on status changes, and this analytics
  // sync must never trigger customer-facing notifications.
  const body = await post("pushOrderData", {
    username,
    password: licenseKey,
    carrier_id: order.carrierId,
    awb: order.awb,
    order_id: order.orderId,
    first_name: "N/A",
    last_name: "N/A",
    email: "N/A",
    phone: "N/A",
    products: "N/A",
    company: "N/A",
  });
  return isRecord(body) && String(body.status ?? "").toLowerCase() === "success";
}
