import { describe, it, expect, beforeEach } from "vitest";
import { signState, verifyState } from "../../src/lib/state-token.js";

beforeEach(() => {
  process.env.STATE_SIGNING_SECRET = "test-state-secret-0123456789abcdef";
});

describe("state-token", () => {
  it("round-trips a signed state token", async () => {
    const token = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    const payload = await verifyState(token);
    expect(payload).toMatchObject({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
  });

  it("rejects a tampered token", async () => {
    const token = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    await expect(verifyState(tampered)).rejects.toThrow();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signState({ clientId: "abc-fashion", platform: "shopify", teamMemberId: "11111111-1111-1111-1111-111111111111" });
    process.env.STATE_SIGNING_SECRET = "a-completely-different-secret-value";
    await expect(verifyState(token)).rejects.toThrow();
  });
});
