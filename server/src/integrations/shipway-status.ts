import type { ShipmentStatus } from "./delhivery-status.js";

// Sourced from Shipway's own API doc v3.1.2 ("Shipment Statuses and their meaning") —
// unlike the Delhivery mapping, these codes are documented, exact strings.
// null = codes with no sensible place in our status model (lost, not-found, other):
// the caller logs and falls back to In Transit, same policy as the other couriers.
const STATUS_BY_CODE: Record<string, ShipmentStatus | null> = {
  DEL: "Delivered",
  INT: "In Transit",
  UND: "NDR",
  RTO: "RTO Initiated",
  RTD: "RTO Delivered",
  CAN: "Cancelled",
  SCH: "Dispatched", // Shipment Booked
  PKP: "In Transit", // Picked Up
  ONH: "In Transit", // On Hold
  OOD: "Out for Delivery",
  NWI: "In Transit", // Network Issue
  DNB: "In Transit", // Delivery Next Day
  NFI: null, // Not Found / Incorrect
  ODA: "NDR", // Out of Delivery Area
  OTH: null, // Others
  SMD: "In Transit", // Delivery Delayed
  "22": "NDR", // Address Incorrect
  "23": "NDR", // Delivery Attempted
  "24": "NDR", // Pending - Undelivered
  "25": "NDR", // Delivery Attempted - Premises Closed
  CRTA: "NDR", // Customer Refused
  CNA: "NDR", // Consignee Unavailable
  DEX: "NDR", // Delivery Exception
  DRE: "NDR", // Delivery Rescheduled
  PNR: "NDR", // COD Payment Not Ready
  LOST: null,
};

export function mapShipwayStatus(code: string | null | undefined): ShipmentStatus | null {
  const key = (code ?? "").trim().toUpperCase();
  if (!key) return null;
  return STATUS_BY_CODE[key] ?? null;
}
