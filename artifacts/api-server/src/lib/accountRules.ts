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
  .string({ required_error: "Password is required" })
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
