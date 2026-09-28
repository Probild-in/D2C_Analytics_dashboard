import { describe, it, expect } from "vitest";
import { mapShiprocketStatus } from "../../src/integrations/shiprocket-status.js";

describe("mapShiprocketStatus", () => {
  it.each([
    ["NEW", "Dispatched"],
    ["INVOICED", "Dispatched"],
    ["READY TO SHIP", "Dispatched"],
    ["PICKUP SCHEDULED", "Dispatched"],
    ["PICKUP GENERATED", "Dispatched"],
    ["OUT FOR PICKUP", "Dispatched"],
    ["MANIFEST GENERATED", "Dispatched"],
    ["AWB ASSIGNED", "Dispatched"],
    ["PICKED UP", "In Transit"],
    ["SHIPPED", "In Transit"],
    ["IN TRANSIT", "In Transit"],
    ["REACHED AT DESTINATION HUB", "In Transit"],
    ["OUT FOR DELIVERY", "Out for Delivery"],
    ["DELIVERED", "Delivered"],
    ["UNDELIVERED", "NDR"],
    ["UNDELIVERED-1st Attempt", "NDR"],
    ["NDR", "NDR"],
    ["RTO INITIATED", "RTO Initiated"],
    ["RTO IN TRANSIT", "RTO Initiated"],
    ["RTO OFD", "RTO Initiated"],
    ["RTO DELIVERED", "RTO Delivered"],
    ["CANCELED", "Cancelled"],
    ["CANCELLATION REQUESTED", "Cancelled"],
    ["  delivered  ", "Delivered"],
    ["rto delivered", "RTO Delivered"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapShiprocketStatus(raw)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["   "], ["LOST"], ["SOMETHING NEW"]])("returns null for %j", (raw) => {
    expect(mapShiprocketStatus(raw as string | null | undefined)).toBeNull();
  });
});
