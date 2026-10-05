import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "crypto";

const SECRET = process.env["SESSION_SECRET"] ?? "";

// Dedicated AES-256 key derived from SESSION_SECRET via HKDF, so the encryption
// key is cryptographically separated from the JWT signing key (which uses the
// raw SESSION_SECRET) and carries full 32-byte entropy rather than a raw slice.
const ENC_KEY = Buffer.from(hkdfSync("sha256", SECRET, "", "kkamera-cloud-credential-encryption", 32));

// Legacy key = the old raw first-32-chars-of-secret scheme. Retained ONLY so
// values encrypted before the HKDF migration can still be decrypted.
const LEGACY_KEY = Buffer.from(SECRET.slice(0, 32).padEnd(32, "\0").slice(0, 32));

/**
 * AES-256-GCM (authenticated encryption — tampering with the ciphertext is
 * detected at decrypt time). Format: "gcm:<iv>:<authTag>:<ciphertext>" hex.
 */
export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return `gcm:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

/**
 * Decrypt a stored credential, treating a decryption FAILURE as an error rather
 * than silently yielding "". Returns "" only when there is genuinely no stored
 * value (null/empty). Use this for credentials that get sent to third parties
 * (FTP/WebDAV passwords, OAuth tokens) so a corrupt value fails loudly instead of
 * connecting with an empty secret.
 */
export function decryptCredential(enc: string | null | undefined): string {
  if (!enc) return "";
  const out = decrypt(enc);
  if (out === "") throw new Error("Stored credential could not be decrypted");
  return out;
}

function decryptGcm(key: Buffer, ivHex: string, tagHex: string, dataHex: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
}

export function decrypt(enc: string): string {
  try {
    // Only authenticated AES-256-GCM is accepted. The old unauthenticated
    // AES-256-CBC path was removed — CBC ciphertext is malleable, and nothing in
    // production predates GCM. Anything not in gcm: form is treated as a failure
    // (returns "" — callers must treat "" from a non-empty ciphertext as an error).
    if (!enc.startsWith("gcm:")) return "";
    const [, ivHex, tagHex, dataHex] = enc.split(":");
    if (!ivHex || !tagHex || !dataHex) return "";
    // New values use the HKDF key; values written before the migration use the
    // legacy key. GCM auth fails cleanly on the wrong key, so try the new key
    // first and fall back to the legacy one.
    try {
      return decryptGcm(ENC_KEY, ivHex, tagHex, dataHex);
    } catch {
      return decryptGcm(LEGACY_KEY, ivHex, tagHex, dataHex);
    }
  } catch {
    return "";
  }
}
