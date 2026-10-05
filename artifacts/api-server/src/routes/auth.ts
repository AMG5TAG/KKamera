import { Router } from "express";
import { randomBytes } from "crypto";
import bcryptjs from "bcryptjs";
import { z } from "zod";
import { authenticator } from "@otplib/preset-default";
import QRCode from "qrcode";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import {
  usersTable, subscriptionsTable, referralsTable, passwordResetTokensTable, emailVerificationsTable,
} from "@workspace/db";
import { eq, and, isNull, isNotNull, or, lt, sql } from "drizzle-orm";
import { requireAuth, issueSessionToken } from "../middlewares/auth.js";
import { sendEmail, welcomeEmail } from "../lib/email.js";
import {
  generateVerificationNonce, hashVerificationNonce, isVerificationRedeemable, verificationCodeMatches,
  NOTICE_CODE_MARKER, INVALID_CODE_MESSAGE,
} from "../lib/emailVerification.js";
import {
  grantTrialIfEligible, invalidateUnusedVerifications, issueVerificationCode, sendAccountExistsNotice,
  maybeSweepStaleVerifications,
} from "../lib/emailVerificationStore.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import {
  matchTotpStep, openTotpSecret, generateBackupCodes, hashBackupCode, spendBackupCode,
} from "../lib/twoFactor.js";
import {
  newPasswordSchema, normalizedEmailSchema, normalizeReferralCode,
  isLoginLocked, loginLockDurationMs, LOGIN_LOCKED_MESSAGE,
} from "../lib/accountRules.js";

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  // Only failed attempts count, so a shared IP (office / carrier NAT) isn't
  // locked out by its own successful sign-ins. Per-account lockout (below)
  // bounds guessing against any one account across IPs.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
});

// Generous enough for many people behind one carrier-NAT / office IP; bulk
// sign-up abuse is still bounded (and trials are keyed per mailbox).
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many registration attempts. Please try again in an hour." },
});

// Email verification codes are 6 digits; each code dies after 5 wrong tries
// and at most 5 codes/hour are sent per account, so this per-IP bound is a
// second layer against spraying guesses across many pending sign-ups.
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
});

// Sends email — bound per IP (the per-account send throttle bounds per victim).
const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

// TOTP codes (and legacy 32-bit backup codes) are low-entropy enough to
// brute-force without a limiter. These routes are authenticated, so bound
// per authenticated session/IP.
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many 2FA attempts. Please try again in 15 minutes." },
});

// Change-password verifies the current password (and 2FA), so bound guesses per
// account — not just per IP — so rotating IPs can't brute-force it.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { message: "Too many password change attempts. Please try again in 15 minutes." },
});

// Password re-authentication on sensitive authenticated routes (2FA setup /
// enable / disable, "sign out everywhere") — bound guesses per account.
const reauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
});

// ─── Validation schemas ────────────────────────────────────────────────────────

const registerSchema = z.object({
  // Normalise (trim + lowercase) BEFORE validating so case/whitespace variants
  // map to one account and autofilled trailing spaces don't fail validation
  // (email is stored and compared case-sensitively, and so is the DB unique key).
  email: normalizedEmailSchema,
  // Shared rule: min 8 chars, max 72 BYTES (bcrypt's truncation limit).
  password: newPasswordSchema,
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
  referralCode: z.string().nullish(),
});

const loginSchema = z.object({
  email: normalizedEmailSchema,
  password: z.string().min(1, "Password is required"),
  totpCode: z.string().nullish(),
});

// Nonces are 43 base64url chars; bound lengths so junk input is cheap to reject.
const verifyEmailSchema = z.object({
  nonce: z.string().min(1).max(128),
  code: z.string().min(1).max(20),
});

const resendVerificationSchema = z.object({
  nonce: z.string().min(1).max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: newPasswordSchema,
  totpCode: z.string().nullish(),
});

const passwordConfirmSchema = z.object({
  password: z.string({ required_error: "Enter your password to continue." }).min(1, "Enter your password to continue."),
});

const twoFAEnableSchema = z.object({
  code: z.string().length(6, "Code must be 6 digits").regex(/^\d+$/, "Code must be numeric"),
  password: z.string({ required_error: "Enter your password to continue." }).min(1, "Enter your password to continue."),
});

const twoFADisableSchema = z.object({
  code: z.string({ required_error: "Code is required" }).min(1, "Code is required"),
  password: z.string({ required_error: "Enter your password to continue." }).min(1, "Enter your password to continue."),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateReferralCode(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6).padEnd(3, "K");
  // Use a CSPRNG so codes aren't predictable from Math.random's weak state.
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `${clean}${rand}`;
}

// A precomputed bcrypt hash (of a random string) used to spend roughly the same
// time on the "user not found" path as on a real comparison, so response timing
// doesn't reveal whether an email is registered.
const DUMMY_BCRYPT_HASH = "$2b$12$.mHbRuuNFGfnrol8lmQ/sOUly9knVchhRMliScqUwz8h5lSb47iYe";

/**
 * Consume a single-use backup code atomically: re-read the codes under a row
 * lock inside a transaction so two concurrent requests can't both spend the same
 * code (or one resurrect an already-spent code). Accepts new-format (HMAC'd)
 * and legacy 8-hex (SHA-256) codes — see lib/twoFactor.ts.
 */
async function consumeBackupCode(userId: number, code: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ codes: usersTable.twoFABackupCodes })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .for("update")
      .limit(1);
    const codes: string[] = locked?.codes ? JSON.parse(locked.codes) : [];
    const remaining = spendBackupCode(codes, code);
    if (!remaining) return false;
    await tx.update(usersTable)
      .set({ twoFABackupCodes: JSON.stringify(remaining) })
      .where(eq(usersTable.id, userId));
    return true;
  });
}

type TwoFactorUser = { id: number; twoFASecret: string | null };

/**
 * Verify a TOTP code and claim its time step, so each code works once. The claim
 * is one atomic UPDATE ... WHERE totp_last_step IS NULL OR totp_last_step < step,
 * so concurrent requests can't both spend the same code. A legacy plaintext
 * secret is re-encrypted on the first successful verification.
 */
async function verifyTotp(user: TwoFactorUser, code: string): Promise<boolean> {
  const opened = openTotpSecret(user.twoFASecret, decrypt);
  if (!opened) {
    // Never log the stored value — only that it's unusable.
    if (user.twoFASecret) logger.error({ userId: user.id }, "Stored 2FA secret could not be decrypted");
    return false;
  }
  const step = matchTotpStep(code.trim(), opened.secret, Date.now());
  if (step === null) return false;
  const [claimed] = await db.update(usersTable)
    .set({ totpLastStep: step })
    .where(and(
      eq(usersTable.id, user.id),
      or(isNull(usersTable.totpLastStep), lt(usersTable.totpLastStep, step)),
    ))
    .returning({ id: usersTable.id });
  if (!claimed) return false; // replay of an already-accepted step
  if (opened.legacyPlaintext && user.twoFASecret) {
    // Only if the row still holds the same plaintext (no concurrent setup/disable).
    await db.update(usersTable)
      .set({ twoFASecret: encrypt(opened.secret) })
      .where(and(eq(usersTable.id, user.id), eq(usersTable.twoFASecret, user.twoFASecret)));
  }
  return true;
}

/** Verify a TOTP code, falling back to (and consuming) a backup code — as login does. */
async function verifySecondFactor(user: TwoFactorUser, code: string): Promise<boolean> {
  if (await verifyTotp(user, code)) return true;
  return consumeBackupCode(user.id, code);
}

/** Session token carrying the user's current token_version (see requireAuth). */
function issueToken(user: { id: number; tokenVersion: number }): string {
  return issueSessionToken(user.id, user.tokenVersion);
}

export type ReauthResult = { ok: true } | { ok: false; status: 400 | 403; message: string };

/**
 * Re-authenticate the signed-in user for a sensitive action: the current
 * password, plus a TOTP / backup code when 2FA is enabled. Failures are 400
 * (missing input) or 403 (wrong credentials) — NEVER 401, which the app treats
 * as "session revoked" and signs the user out.
 */
export async function verifyReauth(
  user: { id: number; passwordHash: string; twoFAEnabled: boolean; twoFASecret: string | null },
  password: string | null | undefined,
  code: string | null | undefined,
): Promise<ReauthResult> {
  if (!password) return { ok: false, status: 400, message: "Enter your password to continue." };
  if (!(await bcryptjs.compare(password, user.passwordHash))) {
    return { ok: false, status: 403, message: "Password is incorrect." };
  }
  if (user.twoFAEnabled && user.twoFASecret) {
    if (!code?.trim()) {
      return { ok: false, status: 400, message: "Enter the code from your authenticator app, or a backup code." };
    }
    if (!(await verifySecondFactor(user, code))) {
      return { ok: false, status: 403, message: "Invalid 2FA code." };
    }
  }
  return { ok: true };
}

/**
 * Record a failed sign-in for an existing account. The increment is one atomic
 * UPDATE ... RETURNING, and the lockout length is derived from the resulting
 * consecutive-failure count. Returns true when this failure locked the account.
 */
async function recordLoginFailure(userId: number): Promise<boolean> {
  const [row] = await db.update(usersTable)
    .set({ failedLoginCount: sql`${usersTable.failedLoginCount} + 1` })
    .where(eq(usersTable.id, userId))
    .returning({ failedLoginCount: usersTable.failedLoginCount });
  const lockMs = row ? loginLockDurationMs(row.failedLoginCount) : 0;
  if (lockMs <= 0) return false;
  await db.update(usersTable)
    .set({ loginLockedUntil: new Date(Date.now() + lockMs) })
    .where(eq(usersTable.id, userId));
  return true;
}

function formatUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    referralCode: user.referralCode,
    twoFAEnabled: user.twoFAEnabled,
    onboardingCompleted: user.onboardingCompleted,
    createdAt: user.createdAt.toISOString(),
  };
}

// ─── Register ─────────────────────────────────────────────────────────────────
// Registration never signs anyone in: the account (or, for an address that's
// already registered but unverified, this registration's credentials) only
// takes effect once the 6-digit code emailed to the address is entered with the
// nonce returned here (POST /auth/verify-email). The response is the same 202
// shape whether the address is new, pending or already verified, so it can't be
// used to discover which emails have accounts.

type RegisteredUser = typeof usersTable.$inferSelect;

function isEmailUniqueViolation(err: unknown): boolean {
  const pgErr = ((err as { cause?: unknown })?.cause ?? err) as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && String(pgErr.constraint ?? "").includes("email");
}

router.post("/auth/register", registerLimiter, async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { email, password, name, referralCode } = parsed.data;
    maybeSweepStaleVerifications();

    // Hash up front on every path so response timing doesn't depend on
    // whether the address is registered.
    const passwordHash = await bcryptjs.hash(password, 12);

    let [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);

    if (!existing) {
      let referrerId: number | undefined;
      const normalizedReferral = normalizeReferralCode(referralCode);
      if (normalizedReferral) {
        // Only verified accounts can refer (an unverified account can't sign in
        // to see its code, and may be swept after 30 days).
        const referrer = await db.select({ id: usersTable.id }).from(usersTable)
          .where(and(
            sql`upper(${usersTable.referralCode}) = ${normalizedReferral}`,
            isNotNull(usersTable.emailVerifiedAt),
          )).limit(1);
        if (referrer.length > 0) referrerId = referrer[0]!.id;
      }

      try {
        // One transaction: a failure part-way must never leave a user without a
        // subscription row. No trial yet — it starts when the email is verified
        // (grantTrialIfEligible), so unverified addresses can't burn or farm one.
        const created = await db.transaction(async (tx) => {
          const [row] = await tx.insert(usersTable).values({
            email, passwordHash, name, referralCode: generateReferralCode(name),
            referrerId: referrerId ?? null, twoFAEnabled: false, emailVerifiedAt: null,
          }).returning();
          if (!row) throw new Error("User insert returned no row");
          await tx.insert(subscriptionsTable).values({ userId: row.id, status: "none" });
          if (referrerId) {
            // Referral is "pending" until the referred user subscribes (completed via webhook)
            await tx.insert(referralsTable).values({
              referrerId, referredId: row.id, referredName: name, status: "pending",
            });
          }
          return row;
        });
        const { nonce } = await issueVerificationCode({ user: created, passwordHash, name });
        res.status(202).json({ status: "verification_required", nonce, email });
        return;
      } catch (err) {
        // Unique-violation race: another request registered this email between
        // our existence check and the insert — continue as "already exists".
        if (!isEmailUniqueViolation(err)) throw err;
        [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
        if (!existing) throw err;
      }
    }

    const nonce = await registerExistingAddress(existing, passwordHash, name);
    res.status(202).json({ status: "verification_required", nonce, email });
  } catch (err) {
    req.log.error({ err }, "Register error");
    res.status(500).json({ message: "Registration failed" });
  }
});

/**
 * Registration for an address that already has an account. Unverified: the
 * account row is left untouched and a new code is issued carrying THIS
 * registration's password/name — whoever can read the inbox and holds the
 * nonce decides which credentials the account ends up with. Verified: nothing
 * that grants access is created; the owner gets a (throttled) heads-up email
 * and the caller a dummy nonce that verifies like a wrong code.
 */
async function registerExistingAddress(existing: RegisteredUser, passwordHash: string, name: string): Promise<string> {
  if (!existing.emailVerifiedAt) {
    const { nonce } = await issueVerificationCode({ user: existing, passwordHash, name });
    return nonce;
  }
  const dummyNonce = generateVerificationNonce();
  await sendAccountExistsNotice(existing, dummyNonce);
  return dummyNonce;
}

// ─── Verify email ─────────────────────────────────────────────────────────────
// Redeems a code for the row bound to `nonce`. Any failure is the same generic
// 400 — including an unknown nonce — so it reveals nothing about the address.
// On success the account is verified (applying the credentials the verified
// registration carried), the free trial starts if eligible, and the caller is
// signed in.

router.post("/auth/verify-email", verifyEmailLimiter, async (req, res) => {
  try {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: INVALID_CODE_MESSAGE });
      return;
    }
    const { nonce, code } = parsed.data;
    const nonceHash = hashVerificationNonce(nonce);
    maybeSweepStaleVerifications();

    const result = await db.transaction(async (tx) => {
      const now = new Date();
      // Row lock: concurrent guesses against one code serialise, so the attempt
      // counter can't be raced past the limit and a code is redeemed only once.
      const [row] = await tx.select().from(emailVerificationsTable)
        .where(eq(emailVerificationsTable.nonceHash, nonceHash)).for("update").limit(1);
      if (!row || !isVerificationRedeemable(row, now)) return null;

      if (!verificationCodeMatches(row.codeHash, nonceHash, code)) {
        await tx.update(emailVerificationsTable)
          .set({ attempts: sql`${emailVerificationsTable.attempts} + 1` })
          .where(eq(emailVerificationsTable.id, row.id));
        return null;
      }

      const [user] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, row.userId)).for("update").limit(1);
      // Codes are only issued to unverified accounts, and verifying (or a
      // password reset) voids the rest — a still-open row on a verified account
      // must never be able to overwrite its password.
      if (!user || user.emailVerifiedAt) return null;

      await tx.update(emailVerificationsTable).set({ usedAt: now }).where(eq(emailVerificationsTable.id, row.id));
      await invalidateUnusedVerifications(tx, user.id, now);

      const [updated] = await tx.update(usersTable)
        .set({
          emailVerifiedAt: now,
          failedLoginCount: 0,
          loginLockedUntil: null,
          ...(row.name ? { name: row.name } : {}),
          // The registration being verified sets the password; revoke anything
          // issued before (there shouldn't be sessions for an unverified account).
          ...(row.passwordHash
            ? { passwordHash: row.passwordHash, passwordChangedAt: now, tokenVersion: sql`${usersTable.tokenVersion} + 1` }
            : {}),
        })
        .where(eq(usersTable.id, user.id))
        .returning();
      if (!updated) return null;
      const trialGranted = await grantTrialIfEligible(tx, updated);
      return { user: updated, trialGranted };
    });

    if (!result) {
      res.status(400).json({ message: INVALID_CODE_MESSAGE });
      return;
    }

    const welcome = welcomeEmail(result.user.name, result.trialGranted);
    sendEmail({ to: result.user.email, ...welcome }).catch(() => {});

    res.json({ token: issueToken(result.user), user: formatUser(result.user) });
  } catch (err) {
    req.log.error({ err }, "Verify email error");
    res.status(500).json({ message: "Verification failed" });
  }
});

// ─── Resend verification code ─────────────────────────────────────────────────
// Issues a new code for the account behind `nonce` (expired or superseded rows
// are fine — that's the point) carrying the same pending credentials, subject
// to the per-account send throttle. Always 200 with a nonce: a dummy one when
// there's nothing to resend.

router.post("/auth/resend-verification", resendVerificationLimiter, async (req, res) => {
  try {
    const parsed = resendVerificationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const [row] = await db.select().from(emailVerificationsTable)
      .where(eq(emailVerificationsTable.nonceHash, hashVerificationNonce(parsed.data.nonce))).limit(1);
    if (row && row.codeHash !== NOTICE_CODE_MARKER) {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, row.userId)).limit(1);
      if (user && !user.emailVerifiedAt) {
        const { nonce } = await issueVerificationCode({ user, passwordHash: row.passwordHash, name: row.name });
        res.json({ nonce });
        return;
      }
    }
    res.json({ nonce: generateVerificationNonce() });
  } catch (err) {
    req.log.error({ err }, "Resend verification error");
    res.status(500).json({ message: "Failed to resend code" });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

router.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { email, password, totpCode } = parsed.data;

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user) {
      // Spend comparable time so timing doesn't reveal whether the email exists.
      // Unknown emails never see the lockout response — only a real account
      // can reveal itself, and only after LOGIN_LOCK_THRESHOLD failures.
      await bcryptjs.compare(password, DUMMY_BCRYPT_HASH);
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    // Per-account lockout: checked before the password so a locked account
    // gives no password oracle to an attacker rotating IPs.
    if (isLoginLocked(user.loginLockedUntil, new Date())) {
      res.status(429).json({ message: LOGIN_LOCKED_MESSAGE });
      return;
    }

    const valid = await bcryptjs.compare(password, user.passwordHash);
    if (!valid) {
      if (await recordLoginFailure(user.id)) {
        res.status(429).json({ message: LOGIN_LOCKED_MESSAGE });
        return;
      }
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    // Correct password but the address was never proven: no session. Email a
    // code (throttled) bound to a nonce only this client gets. 403, not 401 —
    // the client isn't signed in, and 401 means "session revoked" to the app.
    // Failure counters are left alone; verifying resets them.
    if (!user.emailVerifiedAt) {
      const { nonce } = await issueVerificationCode({ user });
      res.status(403).json({
        code: "email_not_verified",
        nonce,
        email: user.email,
        message: "Verify your email to continue. We've sent you a code.",
      });
      return;
    }

    if (user.twoFAEnabled && user.twoFASecret) {
      if (!totpCode) { res.status(200).json({ requires2FA: true }); return; }

      // Try TOTP first, then (single-use) backup codes
      if (!(await verifySecondFactor(user, totpCode))) {
        if (await recordLoginFailure(user.id)) {
          res.status(429).json({ message: LOGIN_LOCKED_MESSAGE });
          return;
        }
        res.status(401).json({ message: "Invalid 2FA code" });
        return;
      }
    }

    // Full success: clear the consecutive-failure counter (no write when clean).
    if (user.failedLoginCount > 0 || user.loginLockedUntil) {
      await db.update(usersTable)
        .set({ failedLoginCount: 0, loginLockedUntil: null })
        .where(eq(usersTable.id, user.id));
    }

    const token = issueToken(user);
    res.json({ token, user: formatUser(user) });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ message: "Login failed" });
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post("/auth/logout", (_req, res) => {
  // JWT is stateless; client discards the token
  res.json({ message: "Logged out" });
});

// ─── Sign out of all other devices ───────────────────────────────────────────
// Bumps token_version (every existing session, including this one, is revoked)
// and returns a fresh token so the calling device stays signed in.

router.post("/auth/logout-all", requireAuth, reauthLimiter, async (req, res) => {
  try {
    const [updated] = await db.update(usersTable)
      .set({ tokenVersion: sql`${usersTable.tokenVersion} + 1` })
      .where(eq(usersTable.id, req.userId!))
      .returning();
    if (!updated) { res.status(404).json({ message: "User not found" }); return; }
    res.json({ message: "Signed out of all other devices", token: issueToken(updated), user: formatUser(updated) });
  } catch (err) {
    req.log.error({ err }, "Logout-all error");
    res.status(500).json({ message: "Failed to sign out other devices" });
  }
});

// ─── Change password ──────────────────────────────────────────────────────────
// Errors use 400 (not 401): the client treats any 401 as "session revoked" and
// signs the user out, which a mistyped current password must not do.

router.post("/auth/change-password", requireAuth, changePasswordLimiter, async (req, res) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { currentPassword, newPassword, totpCode } = parsed.data;

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }

    const valid = await bcryptjs.compare(currentPassword, user.passwordHash);
    if (!valid) { res.status(400).json({ message: "Current password is incorrect" }); return; }

    if (user.twoFAEnabled && user.twoFASecret) {
      if (!totpCode?.trim()) {
        res.status(400).json({ message: "Enter the code from your authenticator app, or a backup code." });
        return;
      }
      if (!(await verifySecondFactor(user, totpCode))) {
        res.status(400).json({ message: "Invalid 2FA code" });
        return;
      }
    }

    if (await bcryptjs.compare(newPassword, user.passwordHash)) {
      res.status(400).json({ message: "New password must be different from your current password" });
      return;
    }

    const passwordHash = await bcryptjs.hash(newPassword, 12);
    // Bumping passwordChangedAt makes requireAuth reject every token issued
    // before now (other devices are signed out); this device gets a fresh token.
    const changedAt = new Date();
    const [updated] = await db.transaction(async (tx) => {
      // Any outstanding reset link was issued for the old password — void it.
      await tx.delete(passwordResetTokensTable).where(and(
        eq(passwordResetTokensTable.userId, user.id),
        isNull(passwordResetTokensTable.usedAt),
      ));
      return tx.update(usersTable)
        .set({
          passwordHash,
          passwordChangedAt: changedAt,
          tokenVersion: sql`${usersTable.tokenVersion} + 1`,
        })
        .where(eq(usersTable.id, user.id))
        .returning();
    });
    if (!updated) { res.status(404).json({ message: "User not found" }); return; }

    res.json({ token: issueToken(updated), user: formatUser(updated) });
  } catch (err) {
    req.log.error({ err }, "Change password error");
    res.status(500).json({ message: "Failed to change password" });
  }
});

// ─── 2FA Setup ────────────────────────────────────────────────────────────────
// Every 2FA change re-verifies the current password: a stolen session token
// alone must not be able to lock the owner out (enable) or strip protection
// (disable). Wrong credentials are 403, never 401 (see verifyReauth).

router.post("/auth/2fa/setup", requireAuth, reauthLimiter, async (req, res) => {
  try {
    const parsed = passwordConfirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    // Don't let an already-enabled secret be silently overwritten — the user
    // must disable 2FA first (which requires a valid code or backup code).
    if (user.twoFAEnabled) {
      res.status(400).json({ message: "2FA is already enabled. Disable it before setting up again." });
      return;
    }
    const reauth = await verifyReauth(user, parsed.data.password, null);
    if (!reauth.ok) { res.status(reauth.status).json({ message: reauth.message }); return; }

    const secret = authenticator.generateSecret();

    // Generate and hash backup codes — return plaintext once, store hashes
    const backupCodesPlain = generateBackupCodes();
    const backupCodesHashed = backupCodesPlain.map(hashBackupCode);

    // The secret is stored encrypted (crypto.ts); a fresh secret starts a fresh
    // replay window.
    await db.update(usersTable).set({
      twoFASecret: encrypt(secret),
      twoFABackupCodes: JSON.stringify(backupCodesHashed),
      totpLastStep: null,
    }).where(eq(usersTable.id, req.userId!));

    const otpauth = authenticator.keyuri(user.email, "KKamera", secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);

    res.json({ secret, qrCodeUrl, backupCodes: backupCodesPlain });
  } catch (err) {
    req.log.error({ err }, "2FA setup error");
    res.status(500).json({ message: "2FA setup failed" });
  }
});

// ─── 2FA Verify (enable) ──────────────────────────────────────────────────────
// Enabling 2FA revokes every other session (token_version bump); the response
// carries a fresh token for this device.

router.post("/auth/2fa/verify", twoFactorLimiter, requireAuth, async (req, res) => {
  try {
    const parsed = twoFAEnableSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid code" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user?.twoFASecret) { res.status(400).json({ message: "2FA not set up" }); return; }
    if (user.twoFAEnabled) { res.status(400).json({ message: "2FA is already enabled." }); return; }
    // Password only — 2FA isn't enabled yet, so verifyReauth skips the code.
    const reauth = await verifyReauth(user, parsed.data.password, null);
    if (!reauth.ok) { res.status(reauth.status).json({ message: reauth.message }); return; }
    if (!(await verifyTotp(user, parsed.data.code))) { res.status(400).json({ message: "Invalid code" }); return; }
    const [updated] = await db.update(usersTable)
      .set({ twoFAEnabled: true, tokenVersion: sql`${usersTable.tokenVersion} + 1` })
      .where(eq(usersTable.id, req.userId!))
      .returning();
    if (!updated) { res.status(404).json({ message: "User not found" }); return; }
    res.json({ message: "2FA enabled successfully", token: issueToken(updated), user: formatUser(updated) });
  } catch (err) {
    req.log.error({ err }, "2FA verify error");
    res.status(500).json({ message: "2FA verification failed" });
  }
});

// ─── 2FA Disable ──────────────────────────────────────────────────────────────

router.post("/auth/2fa/disable", twoFactorLimiter, requireAuth, async (req, res) => {
  try {
    const parsed = twoFADisableSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user?.twoFAEnabled || !user.twoFASecret) { res.status(400).json({ message: "2FA not enabled" }); return; }

    // Password + TOTP or (single-use) backup code — the recovery path.
    const reauth = await verifyReauth(user, parsed.data.password, parsed.data.code);
    if (!reauth.ok) { res.status(reauth.status).json({ message: reauth.message }); return; }

    const [updated] = await db.update(usersTable).set({
      twoFAEnabled: false,
      twoFASecret: null,
      twoFABackupCodes: null,
      totpLastStep: null,
      tokenVersion: sql`${usersTable.tokenVersion} + 1`,
    }).where(eq(usersTable.id, req.userId!)).returning();
    if (!updated) { res.status(404).json({ message: "User not found" }); return; }
    res.json({ message: "2FA disabled", token: issueToken(updated), user: formatUser(updated) });
  } catch (err) {
    req.log.error({ err }, "2FA disable error");
    res.status(500).json({ message: "2FA disable failed" });
  }
});

export default router;
