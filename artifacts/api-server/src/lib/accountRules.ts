// Pure account/auth rules — no DB imports, so they're unit-testable
// (see test/accountRules.test.ts). Routes and trialReminder.ts wrap them.
import { z } from "zod";

// ─── Passwords ────────────────────────────────────────────────────────────────

export const PASSWORD_MIN_CHARS = 8;
/** bcrypt silently truncates input past 72 BYTES (not characters). */
export const PASSWORD_MAX_BYTES = 72;

/**
 * The single password rule shared by register, reset and change-password.
 * Min is in characters (what the user sees); max is in UTF-8 bytes because
 * bcrypt truncates at 72 bytes — without it two long passwords sharing a
 * 72-byte prefix would collide (and multi-byte characters would slip past a
 * character-count cap).
 */
export const newPasswordSchema = z
  .string({ error: "Password is required" })
  .min(PASSWORD_MIN_CHARS, `Password must be at least ${PASSWORD_MIN_CHARS} characters`)
  .refine(p => Buffer.byteLength(p, "utf8") <= PASSWORD_MAX_BYTES, {
    message: `Password is too long (maximum ${PASSWORD_MAX_BYTES} bytes)`,
  });

// ─── Emails / codes ───────────────────────────────────────────────────────────

/** Trim + lowercase BEFORE validation so autofilled trailing spaces pass. */
export const normalizedEmailSchema = z.preprocess(
  v => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.string().email("Invalid email address"),
);

/** Referral codes are generated uppercase; accept any case / stray whitespace. */
export function normalizeReferralCode(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase();
  return c ? c : null;
}

// ─── Trial reminder ───────────────────────────────────────────────────────────

export const TRIAL_REMINDER_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

export interface TrialReminderInput {
  status: string;
  trialEnd: Date | null;
  trialReminderSentAt: Date | null;
}

/**
 * Due when the user is on a trial that ends within the reminder window (and
 * hasn't already ended), and no reminder has been sent yet.
 */
export function isTrialReminderDue(
  input: TrialReminderInput,
  now: Date,
  windowDays: number = TRIAL_REMINDER_WINDOW_DAYS,
): boolean {
  if (input.status !== "trial") return false;
  if (input.trialReminderSentAt) return false;
  if (!input.trialEnd) return false;
  const remaining = input.trialEnd.getTime() - now.getTime();
  return remaining > 0 && remaining <= windowDays * DAY_MS;
}

/** Whole days left in the trial, rounded up, never below 1 (for email copy). */
export function trialDaysLeft(trialEnd: Date, now: Date): number {
  return Math.max(1, Math.ceil((trialEnd.getTime() - now.getTime()) / DAY_MS));
}

// ─── GDPR export ──────────────────────────────────────────────────────────────

type Dateish = Date | string | null | undefined;

function iso(d: Dateish): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : d;
}

export interface ExportSource {
  user: {
    id: number; email: string; name: string; referralCode: string;
    twoFAEnabled: boolean; onboardingCompleted: boolean;
    uploadTargetMode: string; uploadTargetIds: string | null;
    createdAt: Date;
  };
  subscription: {
    status: string; trialStart: Dateish; trialEnd: Dateish;
    currentPeriodEnd: Dateish; freeYearsAwarded: number; createdAt: Dateish;
  } | null;
  cloudConnections: Array<{
    id: number; type: string; provider: string | null; name: string;
    host: string | null; port: number | null; username: string | null;
    uploadPath: string | null; accountLabel: string | null;
    active: boolean; createdAt: Dateish;
  }>;
  referralsMade: Array<{ id: number; referredName: string; status: string; createdAt: Dateish }>;
  referredBy: Array<{ id: number; status: string; createdAt: Dateish }>;
  uploads: Array<{ id: number; fileName: string; fileType: string; status: string; createdAt: Dateish }>;
  feedback: Array<{ id: number; type: string; message: string; createdAt: Dateish }>;
}

/** Parse the stored CSV of connection ids into a positive-int array. */
export function parseTargetIds(csv: string | null): number[] {
  if (!csv) return [];
  return csv.split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n > 0);
}

/**
 * The stored target CSV with every id not in `keep` removed (e.g. a deleted
 * connection), or null when none remain. A "selected" target left empty means
 * "upload nowhere" — it never widens to all connections.
 */
export function retainTargetIds(csv: string | null, keep: Iterable<number>): string | null {
  const keepSet = new Set(keep);
  const ids = parseTargetIds(csv).filter(id => keepSet.has(id));
  return ids.length ? ids.join(",") : null;
}

/**
 * Shape the user's personal-data export. Every field is copied explicitly so a
 * new secret column (tokens, hashes, TOTP secret, encrypted credentials) can
 * never leak into the export by accident.
 */
export function buildUserExport(src: ExportSource, now: Date) {
  const u = src.user;
  return {
    exportedAt: now.toISOString(),
    user: {
      id: u.id, email: u.email, name: u.name,
      referralCode: u.referralCode, twoFAEnabled: u.twoFAEnabled,
      onboardingCompleted: u.onboardingCompleted,
      createdAt: u.createdAt.toISOString(),
    },
    uploadTarget: { mode: u.uploadTargetMode, connectionIds: parseTargetIds(u.uploadTargetIds) },
    subscription: src.subscription
      ? {
          status: src.subscription.status,
          trialStart: iso(src.subscription.trialStart),
          trialEnd: iso(src.subscription.trialEnd),
          currentPeriodEnd: iso(src.subscription.currentPeriodEnd),
          freeYearsAwarded: src.subscription.freeYearsAwarded,
          createdAt: iso(src.subscription.createdAt),
        }
      : null,
    cloudConnections: src.cloudConnections.map(c => ({
      id: c.id, type: c.type, provider: c.provider, name: c.name,
      host: c.host, port: c.port, username: c.username,
      uploadPath: c.uploadPath, accountLabel: c.accountLabel,
      active: c.active, createdAt: iso(c.createdAt),
    })),
    referrals: src.referralsMade.map(r => ({
      id: r.id, referredName: r.referredName, status: r.status, createdAt: iso(r.createdAt),
    })),
    // Rows where this user is the referred party (who referred them isn't
    // disclosed — that's the referrer's personal data).
    referredBy: src.referredBy.map(r => ({ id: r.id, status: r.status, createdAt: iso(r.createdAt) })),
    uploads: src.uploads.map(x => ({
      id: x.id, fileName: x.fileName, fileType: x.fileType, status: x.status, createdAt: iso(x.createdAt),
    })),
    feedback: src.feedback.map(f => ({ id: f.id, type: f.type, message: f.message, createdAt: iso(f.createdAt) })),
  };
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/** `aud` claim on session JWTs, so other JWTs signed with the same secret can't pose as one. */
export const SESSION_AUDIENCE = "kkamera-session";

export interface SessionClaims {
  userId: number;
  /** users.token_version at issue; legacy tokens without `tv` count as 0. */
  tv: number;
  iat: number | null;
}

/**
 * Validate the claims of an (already signature-verified) session JWT. Returns
 * null for anything that isn't a well-formed session token: a non-positive or
 * non-integer userId, a malformed `tv`, any `typ`, or an `aud` other than ours. `aud` is
 * only checked when present — tokens issued before it was added lack it.
 */
export function parseSessionClaims(payload: unknown): SessionClaims | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const userId = p["userId"];
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) return null;
  // Session tokens carry no `typ`; other JWTs on this secret (OAuth state:
  // typ "oauth-state") must never pass as a session.
  if (p["typ"] !== undefined) return null;
  const aud = p["aud"];
  if (aud !== undefined) {
    const auds = Array.isArray(aud) ? aud : [aud];
    if (!auds.includes(SESSION_AUDIENCE)) return null;
  }
  const tv = p["tv"] ?? 0;
  if (typeof tv !== "number" || !Number.isSafeInteger(tv) || tv < 0) return null;
  const iat = typeof p["iat"] === "number" ? p["iat"] : null;
  return { userId, tv, iat };
}

/** A session is current only while its version matches the user's (bumped to revoke all sessions). */
export function isTokenVersionCurrent(claims: Pick<SessionClaims, "tv">, userTokenVersion: number): boolean {
  return claims.tv === userTokenVersion;
}

// ─── Login throttling ─────────────────────────────────────────────────────────
// Two layers, so guessing is bounded without letting a stranger lock the owner
// out:
//  1. per (account, client IP): LOGIN_IP_FAILURE_LIMIT failures in
//     LOGIN_IP_WINDOW_MS block further password checks for that account from
//     that address only (an IPv6 client is bucketed by its /64). Counted in the
//     shared rate_limit_hits table, so it holds across instances.
//  2. a much higher per-account ceiling (users.failed_login_count) for an
//     attacker rotating through many addresses: every LOGIN_LOCK_THRESHOLD
//     consecutive failures lock the account for at most LOGIN_LOCK_MAX_MS.
// Previously layer 2 alone locked after 5 failures from anywhere, for up to
// 24 h — anyone who knew an email could keep its owner locked out.
// On top of both, each address bucket gets LOGIN_ADDRESS_ATTEMPT_LIMIT
// unsuccessful sign-ins (any accounts, unknown emails included) per
// LOGIN_IP_WINDOW_MS, bounding credential stuffing from one address.

export const LOGIN_IP_FAILURE_LIMIT = 5;
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ADDRESS_ATTEMPT_LIMIT = 10;
export const LOGIN_ADDRESS_LIMITED_MESSAGE = "Too many login attempts. Please try again in 15 minutes.";

/**
 * Whether an address is over its attempt limit. `hits` includes the attempt
 * being made (it is counted up front and given back if it succeeds).
 */
export function isLoginAddressLimited(hits: number): boolean {
  return Number.isFinite(hits) && hits > LOGIN_ADDRESS_ATTEMPT_LIMIT;
}

/** Consecutive failed sign-ins (from any address) that lock the account, and every multiple after. */
export const LOGIN_LOCK_THRESHOLD = 50;
export const LOGIN_LOCK_BASE_MS = 5 * 60 * 1000;
export const LOGIN_LOCK_MAX_MS = 15 * 60 * 1000;
export const LOGIN_LOCKED_MESSAGE = "Too many sign-in attempts. Try again later or reset your password.";

/**
 * How long to lock the account after the failure that brought the consecutive
 * count to `failedCount` (0 = no lock). Every THRESHOLD-th failure locks: 5 min
 * the first time, doubling per further lockout, capped at 15 min.
 */
export function loginLockDurationMs(failedCount: number): number {
  if (!Number.isInteger(failedCount) || failedCount < LOGIN_LOCK_THRESHOLD) return 0;
  if (failedCount % LOGIN_LOCK_THRESHOLD !== 0) return 0;
  const step = failedCount / LOGIN_LOCK_THRESHOLD - 1;
  // Cap the exponent before shifting so huge counts can't overflow.
  if (step >= 16) return LOGIN_LOCK_MAX_MS;
  return Math.min(LOGIN_LOCK_BASE_MS * 2 ** step, LOGIN_LOCK_MAX_MS);
}

/** Whether the account is currently locked out of password sign-in (from every address). */
export function isLoginLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  return !!lockedUntil && lockedUntil.getTime() > now.getTime();
}

/** Whether `hits` failures in the current window block this (account, address) pair. */
export function isLoginIpThrottled(hits: number): boolean {
  return Number.isFinite(hits) && hits >= LOGIN_IP_FAILURE_LIMIT;
}

/** Expand an IPv6 literal to 8 lowercase hextets, or null. */
function ipv6Hextets(ip: string): string[] | null {
  const halves = ip.split("%")[0]!.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

/**
 * The address bucket a sign-in failure is counted against: the IPv4 address
 * (also when IPv4-mapped), or the /64 of an IPv6 address (one subscriber
 * typically gets a whole /64, so per-address counting would be trivial to
 * dodge). Unknown / unparseable input shares one "unknown" bucket.
 */
export function loginIpBucket(ip: string | null | undefined): string {
  const raw = (ip ?? "").trim();
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const v4 = mapped ? mapped[1]! : raw;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4) && v4.split(".").every((o) => Number(o) <= 255)) return v4;
  const hextets = raw.includes(":") ? ipv6Hextets(raw) : null;
  if (hextets) return `${hextets.slice(0, 4).join(":")}::/64`;
  return "unknown";
}

/** Rate-limit key for unsuccessful sign-ins (to any account) from one address bucket. */
export function loginAddressKey(ip: string | null | undefined): string {
  return `login-addr:${loginIpBucket(ip)}`;
}

/** Rate-limit key for failed sign-ins to one account from one address bucket. */
export function loginFailureKey(userId: number, ip: string | null | undefined): string {
  return `login-fail:${userId}:${loginIpBucket(ip)}`;
}

// ─── Password-reset throttling ────────────────────────────────────────────────

/** At most this many reset emails per account per window (the response never changes). */
export const RESET_EMAILS_PER_WINDOW = 3;
export const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000;
