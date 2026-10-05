/**
 * Device binding for OAuth account linking. Pure helpers (only node:crypto)
 * so they are unit-tested directly in test/oauthPending.test.ts.
 *
 * The threat: the signed state names the initiating user, so an attacker could
 * send their own authorize URL to a victim and have the victim's Drive/OneDrive/
 * Dropbox attached to the attacker's account. The callback therefore only
 * stores a PENDING connection, and finalising it needs two one-time values
 * that no single party in that attack holds together:
 *
 *  - the `nonce` returned by /initiate to the device that started the flow
 *    (only its hash travels in the state), and
 *  - the `code` minted by the callback and handed only to the browser/app that
 *    completed the provider sign-in (in the redirect back to the app).
 *
 * The pending row stores H(H(nonce) ":" code) — computable at the callback from
 * the state's nonce hash, and re-computable at /oauth/complete from both
 * values. Neither value is useful on its own, so the code may ride in the
 * redirect URL while the nonce never leaves the initiating device.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a pending (unconfirmed) connection waits for /oauth/complete. */
export const PENDING_CONNECTION_TTL_MS = 10 * 60_000;

// 32 random bytes → 43 base64url chars; 16 → 22.
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** One-time nonce returned to the initiating client. */
export function generateOAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** One-time code minted by the callback and handed to the completing browser. */
export function generateCallbackCode(): string {
  return randomBytes(16).toString("base64url");
}

export function isWellFormedNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && NONCE_RE.test(nonce);
}

export function isWellFormedCallbackCode(code: unknown): code is string {
  return typeof code === "string" && CODE_RE.test(code);
}

/** The nonce hash carried in the signed OAuth state. */
export function hashOAuthNonce(nonce: string): string {
  return sha256(`kkamera-oauth-nonce:${nonce}`);
}

export function isWellFormedNonceHash(hash: unknown): hash is string {
  return typeof hash === "string" && HASH_RE.test(hash);
}

/** Value stored in cloud_connections.pending_nonce_hash for a pending row. */
export function pendingBindingHash(nonceHash: string, code: string): string {
  return sha256(`kkamera-oauth-pending:${nonceHash}:${code}`);
}

/** The binding hash for a (nonce, code) pair presented to /oauth/complete. */
export function bindingHashFor(nonce: string, code: string): string {
  return pendingBindingHash(hashOAuthNonce(nonce), code);
}

/** Constant-time check of a presented (nonce, code) against a stored binding hash. */
export function verifyPendingBinding(nonce: unknown, code: unknown, stored: string | null | undefined): boolean {
  if (!stored || !isWellFormedNonce(nonce) || !isWellFormedCallbackCode(code)) return false;
  const a = Buffer.from(bindingHashFor(nonce, code));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when a pending row's window has closed (a missing expiry counts as expired). */
export function isPendingExpired(expiresAt: Date | null | undefined, now: number = Date.now()): boolean {
  return !expiresAt || expiresAt.getTime() <= now;
}
