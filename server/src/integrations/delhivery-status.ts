// UNSOURCED: no Delhivery documentation was confirmed by any tool available this session
// (Context7 returned only marketing overview text for every query against Delhivery's
// developer portal). Every label below is a general, publicly-known convention about
// Delhivery's status vocabulary, not a documented fact. Confirm against a real account or
// real documentation before trusting this mapping — see the plan's Task 7 checklist.
export type ShipmentStatus =
  | "Dispatched"
  | "In Transit"
  | "Out for Delivery"
  | "Delivered"
  | "NDR"
  | "RTO Initiated"
  | "RTO Delivered"
  | "Cancelled";

const DISPATCHED_PARTS = ["MANIFEST", "PICKUP", "PENDING"];
const IN_TRANSIT_PARTS = ["IN TRANSIT", "PICKED UP", "DISPATCHED"];

export function mapDelhiveryStatus(raw: string | null | undefined): ShipmentStatus | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s) return null;
  // "Lost In Transit"-style labels would otherwise false-match the IN_TRANSIT_PARTS "IN TRANSIT" substring check below; the brief's own test table expects null for these, so this guard runs first.
  if (s.includes("LOST")) return null;
  if (s.includes("RTO")) return s.includes("DELIVERED") ? "RTO Delivered" : "RTO Initiated";
  if (s.includes("CANCEL")) return "Cancelled";
  if (s.includes("UNDELIVERED") || s === "NDR") return "NDR";
  if (s.includes("OUT FOR DELIVERY")) return "Out for Delivery";
  if (s.includes("DELIVERED")) return "Delivered";
  if (IN_TRANSIT_PARTS.some((part) => s.includes(part))) return "In Transit";
  if (DISPATCHED_PARTS.some((part) => s.includes(part))) return "Dispatched";
  return null;
}
