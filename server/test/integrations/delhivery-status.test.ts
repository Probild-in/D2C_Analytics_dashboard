import { describe, it, expect } from "vitest";
import { mapDelhiveryStatus } from "../../src/integrations/delhivery-status.js";

// These labels are NOT sourced from any Delhivery documentation available this session —
// they are the general, publicly-known conventions used by Delhivery's status vocabulary.
// This test locks in this module's OWN behavior so a future correction (once real docs or
// a real account exist) has a clear, deliberate diff to review, not a silent behavior change.
describe("mapDelhiveryStatus", () => {
  it.each([
    ["Manifested", "Dispatched"],
    ["Pickup Scheduled", "Dispatched"],
    ["Pending", "Dispatched"],
    ["Picked Up", "In Transit"],
    ["In Transit", "In Transit"],
    ["Dispatched", "In Transit"],
    ["Out for Delivery", "Out for Delivery"],
    ["Delivered", "Delivered"],
    ["Undelivered", "NDR"],
    ["RTO", "RTO Initiated"],
    ["RTO Initiated", "RTO Initiated"],
    ["RTO In Transit", "RTO Initiated"],
    ["RTO Delivered", "RTO Delivered"],
    ["Cancelled", "Cancelled"],
    ["Canceled", "Cancelled"],
    ["  delivered  ", "Delivered"],
    ["rto delivered", "RTO Delivered"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapDelhiveryStatus(raw)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["   "], ["Lost In Transit"], ["Something Unexpected"]])(
    "returns null for %j",
    (raw) => {
      expect(mapDelhiveryStatus(raw as string | null | undefined)).toBeNull();
    },
  );
});
