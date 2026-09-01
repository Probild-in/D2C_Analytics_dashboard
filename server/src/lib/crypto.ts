import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 32-byte (64 hex char) value");
  }
  return Buffer.from(hex, "hex");
}

// Format: base64(iv) . base64(authTag) . base64(ciphertext)
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  if (!ivB64 || !authTagB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}
