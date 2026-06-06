import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Validated at startup in index.ts — safe to assert non-null here
const ENC_KEY = (process.env["SESSION_SECRET"] ?? "").slice(0, 32);

/**
 * AES-256-GCM (authenticated encryption — tampering with the ciphertext is
 * detected at decrypt time). Format: "gcm:<iv>:<authTag>:<ciphertext>" hex.
 */
export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(ENC_KEY), iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return `gcm:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

export function decrypt(enc: string): string {
  try {
    if (enc.startsWith("gcm:")) {
      const [, ivHex, tagHex, dataHex] = enc.split(":");
      if (!ivHex || !tagHex || !dataHex) return "";
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
    }
    // Legacy AES-256-CBC format: "<iv>:<ciphertext>" — still readable; new writes use GCM
    const [ivHex, dataHex] = enc.split(":");
    if (!ivHex || !dataHex) return "";
    const decipher = createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
  } catch {
    return "";
  }
}
