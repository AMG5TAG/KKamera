import { createHmac } from "crypto";

/**
 * Stable, non-reversible key for a normalised email, used to remember that an
 * address has already used its free trial (see trialHistoryTable) without storing
 * the address. Keyed by SESSION_SECRET so it isn't a plain email hash.
 */
export function emailTrialHash(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHmac("sha256", process.env["SESSION_SECRET"] ?? "").update(normalized).digest("hex");
}
