import { createHmac } from "crypto";

function hmac(value: string): string {
  return createHmac("sha256", process.env["SESSION_SECRET"] ?? "").update(value).digest("hex");
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Collapse delivery aliases of one mailbox to a single canonical form, used ONLY
 * for the trial-history key (never for the login email): lowercase, drop a
 * "+tag" from the local part (any domain), and for Gmail also ignore dots and
 * treat googlemail.com as gmail.com. So "J.Doe+trial2@googlemail.com" and
 * "jdoe@gmail.com" share one free trial.
 */
export function normalizeEmailForTrial(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0 || at === lower.length - 1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = "gmail.com";
    const undotted = local.replace(/\./g, "");
    if (undotted) local = undotted;
  }
  return `${local}@${domain}`;
}

/**
 * Stable, non-reversible key for a normalised email, used to remember that an
 * address has already used its free trial (see trialHistoryTable) without storing
 * the address. Keyed by SESSION_SECRET so it isn't a plain email hash.
 *
 * LEGACY normalisation (trim + lowercase only) — rows written before alias
 * normalisation carry this hash. Use emailTrialHashes() for lookups.
 */
export function emailTrialHash(email: string): string {
  return hmac(email.trim().toLowerCase());
}

/**
 * Every trial-history key for an address: the legacy hash plus the
 * alias-normalised one (deduplicated). Check ALL of them for a prior trial and
 * record ALL of them when granting one, so both old and new rows keep matching.
 */
export function emailTrialHashes(email: string): string[] {
  const legacy = emailTrialHash(email);
  const alias = hmac(normalizeEmailForTrial(email));
  return alias === legacy ? [legacy] : [legacy, alias];
}
