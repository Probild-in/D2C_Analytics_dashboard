import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken } from "../../src/lib/crypto.js";

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64); // 32 bytes hex, test-only key
});

describe("token encryption", () => {
  it("round-trips a plaintext value", () => {
    const ciphertext = encryptToken("shpat_super_secret_token");
    expect(ciphertext).not.toContain("shpat_super_secret_token");
    expect(decryptToken(ciphertext)).toBe("shpat_super_secret_token");
  });

  it("produces different ciphertext for the same plaintext each time", () => {
    const a = encryptToken("same-value");
    const b = encryptToken("same-value");
    expect(a).not.toBe(b);
  });

  it("throws if the ciphertext has been tampered with", () => {
    const ciphertext = encryptToken("shpat_super_secret_token");
    const tampered = ciphertext.slice(0, -2) + "00";
    expect(() => decryptToken(tampered)).toThrow();
  });
});
