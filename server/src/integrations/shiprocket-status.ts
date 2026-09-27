export type ShipmentStatus =
  | "Dispatched"
  | "In Transit"
  | "Out for Delivery"
  | "Delivered"
  | "NDR"
  | "RTO Initiated"
  | "RTO Delivered"
  | "Cancelled";

const DISPATCHED_EXACT = new Set(["NEW", "INVOICED"]);
const DISPATCHED_PARTS = ["READY TO SHIP", "PICKUP", "MANIFEST", "AWB"];
const IN_TRANSIT_PARTS = ["IN TRANSIT", "SHIPPED", "PICKED UP", "REACHED", "DESTINATION HUB", "MISROUTED"];

// Shiprocket reports free-text status labels. Order matters: RTO labels also contain words
// like DELIVERED / IN TRANSIT, and UNDELIVERED contains DELIVERED, so the specific checks
// run first. Returns null for labels we don't recognize so the caller can log them and pick
// a fallback instead of this function silently guessing.
export function mapShiprocketStatus(raw: string | null | undefined): ShipmentStatus | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("RTO")) return s.includes("DELIVERED") ? "RTO Delivered" : "RTO Initiated";
  if (s.includes("CANCEL")) return "Cancelled";
  if (s.includes("UNDELIVERED") || s === "NDR" || s.startsWith("NDR ")) return "NDR";
  if (s.includes("OUT FOR DELIVERY")) return "Out for Delivery";
  if (s.includes("DELIVERED")) return "Delivered";
  if (IN_TRANSIT_PARTS.some((part) => s.includes(part))) return "In Transit";
  if (DISPATCHED_EXACT.has(s) || DISPATCHED_PARTS.some((part) => s.includes(part))) return "Dispatched";
  return null;
}
