// All knowledge of Shiprocket's HTTP API lives in this file. The response shapes below are
// ASSUMPTIONS (see the plan's Global Constraints): every field is read defensively and an
// unexpected envelope throws, so a wrong assumption surfaces as a failed sync instead of
// garbage rows. Confirm against a real Shiprocket API user before relying on it.
const API_BASE = "https://apiv2.shiprocket.in/v1/external";

// Bad login or an expired/invalid session token. Distinct from transient failures so callers
// can ask the user to reconnect instead of retrying.
export class ShiprocketAuthError extends Error {}

export interface ShiprocketShipment {
  awb: string;
  courier: string | null;
  status: string | null;
  deliveredAt: Date | null;
}

export interface ShiprocketOrder {
  orderRef: string | null;
  status: string | null;
  state: string | null;
  createdAt: Date | null;
  shipments: ShiprocketShipment[];
}

export interface ShiprocketOrdersPage {
  orders: ShiprocketOrder[];
  totalPages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function parseShipment(raw: unknown): ShiprocketShipment | null {
  if (!isRecord(raw)) return null;
  const awb = asString(raw.awb) ?? asString(raw.awb_code);
  if (!awb) return null;
  return {
    awb,
    courier: asString(raw.courier) ?? asString(raw.courier_name),
    status: asString(raw.status),
    deliveredAt: asDate(raw.delivered_date) ?? asDate(raw.delivered_at),
  };
}

function parseOrder(raw: unknown): ShiprocketOrder {
  if (!isRecord(raw)) {
    throw new Error("Shiprocket returned an unexpected order entry");
  }
  const shipments: ShiprocketShipment[] = [];
  if (Array.isArray(raw.shipments)) {
    for (const entry of raw.shipments) {
      const shipment = parseShipment(entry);
      if (shipment) shipments.push(shipment);
    }
  }
  return {
    orderRef: asString(raw.channel_order_id) ?? asString(raw.id),
    status: asString(raw.status),
    state: asString(raw.customer_state),
    createdAt: asDate(raw.created_at),
    shipments,
  };
}

export async function shiprocketLogin(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if ([400, 401, 403, 422].includes(res.status)) {
    throw new ShiprocketAuthError("Shiprocket rejected the login");
  }
  if (!res.ok) {
    throw new Error(`Shiprocket login failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  const token = isRecord(body) ? asString(body.token) : null;
  if (!token) {
    throw new Error("Shiprocket login returned no token");
  }
  return token;
}

export async function fetchOrdersPage(token: string, page: number, perPage: number): Promise<ShiprocketOrdersPage> {
  // Shiprocket's docs disagree on the page-size parameter name (per_page vs limit), so send both.
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage), limit: String(perPage) });
  const res = await fetch(`${API_BASE}/orders?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new ShiprocketAuthError("Shiprocket rejected the session token");
  }
  if (!res.ok) {
    throw new Error(`Shiprocket orders fetch failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Shiprocket returned an unexpected orders response (no data array)");
  }
  const pagination = isRecord(body.meta) && isRecord(body.meta.pagination) ? body.meta.pagination : null;
  const totalPages = pagination && typeof pagination.total_pages === "number" ? pagination.total_pages : 1;
  return { orders: body.data.map((entry) => parseOrder(entry)), totalPages };
}
