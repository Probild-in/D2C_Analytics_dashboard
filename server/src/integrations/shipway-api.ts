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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  // Shipway reports bad credentials in the BODY of a 200, not via 401 — observed live:
  // {"status":"Failed","msg":"Invalid Username or Password"}. Without this the caller
  // sees "nothing tracked" and silently syncs zero rows forever.
  if (isRecord(parsed) && typeof parsed.msg === "string" && /invalid\s+username\s+or\s+password/i.test(parsed.msg)) {
    throw new ShipwayAuthError("Shipway rejected the username/licence key");
  }
  return parsed;
}

// NOT an authentication check: probing live showed /api/carriers returns the full list
// for junk credentials too. Credentials are verified with verifyCredentials() below.
// The docs don't show the response shape, so carrier entries are parsed defensively from
// wherever an array shows up.
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

// Verifies credentials against an endpoint that actually authenticates. Shipway answers
// a bad username/licence key with {"status":"Failed","msg":"Invalid Username or
// Password"}, which post() turns into ShipwayAuthError; a valid key with an unknown
// order id just comes back empty. Throws ShipwayAuthError when the credentials are bad.
export async function verifyCredentials(username: string, licenseKey: string): Promise<void> {
  // Any order id works as the probe — only the credential check matters here.
  await getOrderShipmentDetails(username, licenseKey, "__credential_probe__");
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
