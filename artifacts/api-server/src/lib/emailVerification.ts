// Pure email-verification rules — code/nonce generation and hashing, the
// redeemability decision and the per-account send throttles. No DB and no
// relative imports, so it's unit-testable (see test/emailVerification.test.ts);
// routes/auth.ts wraps it.
import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "crypto";

/** A code is valid for this long after it's sent. */
export const VERIFICATION_CODE_TTL_MS = 30 * 60 * 1000;
/** Wrong guesses allowed per code; the code is dead after this many. */
export const VERIFICATION_MAX_ATTEMPTS = 5;
export const VERIFICATION_CODE_LENGTH = 6;

/** Per-account send throttles (the response never changes when they apply). */
export const VERIFICATION_SENDS_PER_WINDOW = 5;
export const VERIFICATION_SEND_WINDOW_MS = 60 * 60 * 1000;
export const VERIFICATION_MIN_SEND_INTERVAL_MS = 60 * 1000;
/** "Someone tried to register with your email" notices per verified account. */
export const ACCOUNT_EXISTS_NOTICES_PER_WINDOW = 1;

/** Verification rows older than this are deleted by the housekeeping sweep. */
export const VERIFICATION_ROW_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Never-verified accounts with no verification activity for this long are deleted. */
export const UNVERIFIED_ACCOUNT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const INVALID_CODE_MESSAGE = "Invalid or expired code";

// ─── Stored-hash markers ──────────────────────────────────────────────────────
// email_verifications.code_hash holds one of:
//   "h1:<hex>"  — HMAC of a code that was emailed (the only kind that can match)
//   "unsent"    — a row bound to a nonce whose code was NOT emailed because a
//                 throttle applied; it can't be redeemed, but resend-verification
//                 accepts its nonce so the client isn't stranded
//   "notice"    — records an "account already exists" notice to a verified
//                 account (throttle bookkeeping only; never redeemable)
const CODE_HMAC_PREFIX = "h1:";
export const UNSENT_CODE_MARKER = "unsent";
export const NOTICE_CODE_MARKER = "notice";

/** Whether a stored code_hash is a real emailed code (counts toward send throttles). */
export function isSentCodeHash(stored: string): boolean {
  return stored.startsWith(CODE_HMAC_PREFIX);
}

// ─── Codes ────────────────────────────────────────────────────────────────────

/** A uniformly random 6-digit numeric code (leading zeros kept). */
export function generateVerificationCode(): string {
  return String(randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)).padStart(VERIFICATION_CODE_LENGTH, "0");
}

/** Display form for emails: "482 913". */
export function formatVerificationCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** Strip spaces/dashes a user may type or paste; null when it can't be a code. */
export function normalizeVerificationCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`).test(digits) ? digits : null;
}

let codeKey: Buffer | undefined;
/**
 * HMAC key HKDF-derived from SESSION_SECRET with its own info label (separate
 * from the credential-encryption and backup-code keys). Derived lazily so the
 * env is read at first use.
 */
function verificationCodeKey(): Buffer {
  codeKey ??= Buffer.from(hkdfSync("sha256", process.env["SESSION_SECRET"] ?? "", "", "kkamera-email-verification-code-hmac", 32));
  return codeKey;
}

/**
 * Stored form of a code. The row's nonce hash is bound in, so a code hash
 * can't be matched against (or copied to) another row.
 */
export function hashVerificationCode(nonceHash: string, code: string): string {
  return CODE_HMAC_PREFIX + createHmac("sha256", verificationCodeKey()).update(`${nonceHash}:${code}`).digest("hex");
}

/** Constant-time comparison of an input code against the stored hash. */
export function verificationCodeMatches(stored: string, nonceHash: string, input: string): boolean {
  if (!isSentCodeHash(stored)) return false;
  const code = normalizeVerificationCode(input);
  if (!code) return false;
  const a = Buffer.from(hashVerificationCode(nonceHash, code));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Nonces ───────────────────────────────────────────────────────────────────

/** 32 random bytes, base64url — returned only to the client that asked for the code. */
export function generateVerificationNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** Stored lookup key for a nonce (it's high-entropy, so a bare SHA-256 suffices). */
export function hashVerificationNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export interface VerificationRowState {
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
}

/** Whether a code may still be tried against this row (not used, expired, exhausted or unsent). */
export function isVerificationRedeemable(row: VerificationRowState, now: Date): boolean {
  if (row.usedAt) return false;
  if (!isSentCodeHash(row.codeHash)) return false;
  if (row.attempts >= VERIFICATION_MAX_ATTEMPTS) return false;
  return row.expiresAt.getTime() > now.getTime();
}

/**
 * Whether another code may be emailed to an account, given the creation times
 * of the codes actually sent to it recently (any order). At most
 * VERIFICATION_SENDS_PER_WINDOW per window and one per min-interval.
 */
export function canSendVerificationCode(recentSends: Date[], now: Date): boolean {
  const t = now.getTime();
  const inWindow = recentSends.filter(d => t - d.getTime() < VERIFICATION_SEND_WINDOW_MS);
  if (inWindow.length >= VERIFICATION_SENDS_PER_WINDOW) return false;
  return !inWindow.some(d => t - d.getTime() < VERIFICATION_MIN_SEND_INTERVAL_MS);
}

/** Whether an "account already exists" notice may be sent, given recent notice times. */
export function canSendAccountExistsNotice(recentNotices: Date[], now: Date): boolean {
  const t = now.getTime();
  return recentNotices.filter(d => t - d.getTime() < VERIFICATION_SEND_WINDOW_MS).length < ACCOUNT_EXISTS_NOTICES_PER_WINDOW;
}
