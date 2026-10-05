// Pure 2FA rules — TOTP step matching / replay, backup-code format + hashing,
// and the at-rest format of the TOTP secret. No DB and no relative imports, so
// it's unit-testable (see test/twoFactor.test.ts); routes/auth.ts wraps it.
import { createHash, createHmac, hkdfSync, randomInt } from "crypto";
import { authenticator } from "@otplib/preset-default";

// ─── TOTP ─────────────────────────────────────────────────────────────────────

/** RFC 6238 time step (seconds) — otplib's authenticator default. */
export const TOTP_STEP_SECONDS = 30;

/** The TOTP counter (time step) containing `nowMs`. */
export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The time step a 6-digit code matches at `nowMs`, or null when it doesn't
 * match (within otplib's configured window — 0 by default). The epoch is pinned
 * once, so the returned step is exactly the one the code was checked against.
 */
export function matchTotpStep(token: string, secret: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(token) || !secret) return null;
  try {
    const delta = authenticator.clone({ epoch: nowMs }).checkDelta(token, secret);
    return typeof delta === "number" ? totpStepAt(nowMs) + delta : null;
  } catch {
    // Malformed secret — treat as a non-match, never a crash.
    return null;
  }
}

/**
 * A code may be accepted only for a step strictly after the last one accepted
 * for this user, so a code (seen over a shoulder, logged, phished) can't be
 * replayed within its validity window. The DB enforces the same rule atomically
 * (UPDATE ... WHERE totp_last_step IS NULL OR totp_last_step < step).
 */
export function isTotpStepFresh(step: number, lastAcceptedStep: number | null | undefined): boolean {
  return lastAcceptedStep == null || step > lastAcceptedStep;
}

// ─── TOTP secret at rest ──────────────────────────────────────────────────────

/** Prefix written by crypto.ts encrypt() (AES-256-GCM). */
const ENCRYPTED_PREFIX = "gcm:";
const BASE32_SECRET = /^[A-Z2-7]+=*$/;

/** Legacy rows hold the raw base32 secret; new rows hold crypto.ts ciphertext. */
export function isPlaintextTotpSecret(stored: string): boolean {
  return BASE32_SECRET.test(stored);
}

export type OpenedTotpSecret = { secret: string; legacyPlaintext: boolean };

/**
 * Recover the base32 secret from `users.two_fa_secret`. Accepts encrypted values
 * and legacy plaintext (flagged, so the caller re-encrypts it on the next
 * successful verification). Returns null — fail closed — for anything else,
 * including ciphertext that doesn't decrypt (e.g. after a SESSION_SECRET change).
 */
export function openTotpSecret(stored: string | null | undefined, decrypt: (enc: string) => string): OpenedTotpSecret | null {
  if (!stored) return null;
  if (stored.startsWith(ENCRYPTED_PREFIX)) {
    const secret = decrypt(stored);
    return secret && isPlaintextTotpSecret(secret) ? { secret, legacyPlaintext: false } : null;
  }
  return isPlaintextTotpSecret(stored) ? { secret: stored, legacyPlaintext: true } : null;
}

// ─── Backup codes ─────────────────────────────────────────────────────────────

/** Crockford base32: no I, L, O or U, so codes survive being read aloud / retyped. */
const BACKUP_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const BACKUP_CODE_LENGTH = 10; // 50 bits
export const BACKUP_CODE_COUNT = 8;
/** Longest accepted input: the displayed XXXXX-XXXXX form. */
export const BACKUP_CODE_DISPLAY_LENGTH = BACKUP_CODE_LENGTH + 1;

const NEW_CODE = new RegExp(`^[${BACKUP_ALPHABET}]{${BACKUP_CODE_LENGTH}}$`);
/** Codes issued before the Crockford format: 8 hex chars, stored as bare SHA-256. */
const LEGACY_CODE = /^[0-9A-F]{8}$/;
/** Stored-hash prefix for HMAC'd (new-format) codes. */
const HMAC_PREFIX = "h1:";

/** One new backup code in display form (XXXXX-XXXXX). */
export function generateBackupCode(): string {
  let raw = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) raw += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateBackupCode);
}

/**
 * Strip spaces/dashes and uppercase; map Crockford look-alikes (O→0, I/L→1),
 * which never occur in a valid code of either format.
 */
export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

let backupKey: Buffer | undefined;
/**
 * HMAC key HKDF-derived from SESSION_SECRET with its own info label (separate
 * from the credential-encryption key in crypto.ts). Derived lazily so the env
 * is read at first use. Rotating SESSION_SECRET invalidates new-format codes.
 */
function backupCodeKey(): Buffer {
  backupKey ??= Buffer.from(hkdfSync("sha256", process.env["SESSION_SECRET"] ?? "", "", "kkamera-2fa-backup-code-hmac", 32));
  return backupKey;
}

/** Stored form of a new-format code (HMAC-SHA256 — useless offline without the server key). */
export function hashBackupCode(code: string): string {
  const normalized = normalizeBackupCode(code);
  return HMAC_PREFIX + createHmac("sha256", backupCodeKey()).update(normalized).digest("hex");
}

/**
 * The stored hashes an input could match: the HMAC form for a new-format code,
 * or the legacy bare SHA-256 for a legacy 8-hex code. Empty for anything that
 * can't be a backup code (no DB work needed).
 */
export function backupCodeCandidates(input: string): string[] {
  const normalized = normalizeBackupCode(input);
  if (NEW_CODE.test(normalized)) return [hashBackupCode(normalized)];
  if (LEGACY_CODE.test(normalized)) return [createHash("sha256").update(normalized).digest("hex")];
  return [];
}

/**
 * Remove the first stored hash matching the input. Returns the remaining list,
 * or null when nothing matched (codes are single-use).
 */
export function spendBackupCode(stored: string[], input: string): string[] | null {
  const candidates = backupCodeCandidates(input);
  const idx = stored.findIndex(h => candidates.includes(h));
  if (idx === -1) return null;
  return [...stored.slice(0, idx), ...stored.slice(idx + 1)];
}
