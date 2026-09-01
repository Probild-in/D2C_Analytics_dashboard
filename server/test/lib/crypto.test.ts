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

  it("round-trips an empty plaintext value", () => {
    const ciphertext = encryptToken("");
    expect(decryptToken(ciphertext)).toBe("");
  });

  it("throws if the IV segment has been tampered with", () => {
    const ciphertext = encryptToken("test-token");
    const parts = ciphertext.split(".");
    const tampered = "AAA" + parts[0].slice(3) + "." + parts[1] + "." + parts[2];
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws if the auth tag segment has been tampered with", () => {
    const ciphertext = encryptToken("test-token");
    const parts = ciphertext.split(".");
    const tampered = parts[0] + "." + "AAA" + parts[1].slice(3) + "." + parts[2];
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws if CREDENTIAL_ENCRYPTION_KEY is invalid length", () => {
    const oldKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      process.env.CREDENTIAL_ENCRYPTION_KEY = "abc"; // Not 64 hex chars
      expect(() => encryptToken("test")).toThrow(/64 hex char/);
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = oldKey;
    }
  });
});
