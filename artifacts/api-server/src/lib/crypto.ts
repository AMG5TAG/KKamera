import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Validated at startup in index.ts — safe to assert non-null here
const ENC_KEY = (process.env["SESSION_SECRET"] ?? "").slice(0, 32);

export function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY), iv);
  return iv.toString("hex") + ":" + Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
}

export function decrypt(enc: string): string {
  const [ivHex, dataHex] = enc.split(":");
  if (!ivHex || !dataHex) return "";
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
}
