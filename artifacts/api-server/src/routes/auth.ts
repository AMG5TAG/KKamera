import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import bcryptjs from "bcryptjs";
import { z } from "zod";
import { authenticator } from "@otplib/preset-default";
import QRCode from "qrcode";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, referralsTable, trialHistoryTable, passwordResetTokensTable } from "@workspace/db";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { requireAuth, issueSessionToken } from "../middlewares/auth.js";
import { sendEmail, welcomeEmail } from "../lib/email.js";
import { emailTrialHashes } from "../lib/emailHash.js";
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

// TOTP codes and backup codes are low-entropy enough to brute-force without a
// limiter (a backup code is 32 bits). These routes are authenticated, so bound
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

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// A precomputed bcrypt hash (of a random string) used to spend roughly the same
// time on the "user not found" path as on a real comparison, so response timing
// doesn't reveal whether an email is registered.
const DUMMY_BCRYPT_HASH = "$2b$12$.mHbRuuNFGfnrol8lmQ/sOUly9knVchhRMliScqUwz8h5lSb47iYe";

/**
 * Consume a single-use backup code atomically: re-read the codes under a row
 * lock inside a transaction so two concurrent requests can't both spend the same
 * code (or one resurrect an already-spent code).
 */
async function consumeBackupCode(userId: number, code: string): Promise<boolean> {
  const inputHash = hashBackupCode(code.replace(/\s/g, "").toUpperCase());
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ codes: usersTable.twoFABackupCodes })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .for("update")
      .limit(1);
    const codes: string[] = locked?.codes ? JSON.parse(locked.codes) : [];
    const idx = codes.indexOf(inputHash);
    if (idx === -1) return false;
    codes.splice(idx, 1);
    await tx.update(usersTable)
      .set({ twoFABackupCodes: JSON.stringify(codes) })
      .where(eq(usersTable.id, userId));
    return true;
  });
}

/** Verify a TOTP code, falling back to (and consuming) a backup code — as login does. */
async function verifySecondFactor(user: { id: number; twoFASecret: string }, code: string): Promise<boolean> {
  const trimmed = code.trim();
  if (authenticator.verify({ token: trimmed, secret: user.twoFASecret })) return true;
  return consumeBackupCode(user.id, trimmed);
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
    if (!(await verifySecondFactor({ id: user.id, twoFASecret: user.twoFASecret }, code))) {
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

function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(4).toString("hex").toUpperCase());
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

router.post("/auth/register", registerLimiter, async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { email, password, name, referralCode } = parsed.data;

    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ message: "Email already registered" });
      return;
    }

    const passwordHash = await bcryptjs.hash(password, 12);
    const myReferralCode = generateReferralCode(name);

    let referrerId: number | undefined;
    const normalizedReferral = normalizeReferralCode(referralCode);
    if (normalizedReferral) {
      const referrer = await db.select({ id: usersTable.id }).from(usersTable)
        .where(sql`upper(${usersTable.referralCode}) = ${normalizedReferral}`).limit(1);
      if (referrer.length > 0) referrerId = referrer[0]!.id;
    }

    // Grant the 14-day trial only if this email has never had one. The
    // trial_history row (keyed by an HMAC of the email) outlives account deletion,
    // so deleting and re-registering the same address can't farm fresh trials.
    // Both the legacy key and the alias-normalised one (+tags / Gmail dots) are
    // checked and recorded, so old rows and "+trial2" aliases keep matching.
    const emailHashes = emailTrialHashes(email);

    // One transaction: a failure part-way must never leave a user without a
    // subscription row (or a trial recorded for a user that doesn't exist).
    const user = await db.transaction(async (tx) => {
      const [created] = await tx.insert(usersTable).values({
        email, passwordHash, name, referralCode: myReferralCode,
        referrerId: referrerId ?? null, twoFAEnabled: false,
      }).returning();
      if (!created) throw new Error("User insert returned no row");

      const [priorTrial] = await tx.select({ id: trialHistoryTable.id })
        .from(trialHistoryTable).where(inArray(trialHistoryTable.emailHash, emailHashes)).limit(1);

      if (priorTrial) {
        await tx.insert(subscriptionsTable).values({ userId: created.id, status: "none" });
      } else {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 14);
        await tx.insert(subscriptionsTable).values({
          userId: created.id, status: "trial", trialStart: new Date(), trialEnd,
        });
        await tx.insert(trialHistoryTable)
          .values(emailHashes.map((emailHash) => ({ emailHash })))
          .onConflictDoNothing();
      }

      if (referrerId) {
        // Referral is "pending" until the referred user subscribes (completed via webhook)
        await tx.insert(referralsTable).values({
          referrerId, referredId: created.id, referredName: name, status: "pending",
        });
      }
      return created;
    });

    const token = issueToken(user);

    // Fire and forget — never block the response
    const welcome = welcomeEmail(name);
    sendEmail({ to: email, ...welcome }).catch(() => {});

    res.status(201).json({ token, user: formatUser(user) });
  } catch (err) {
    // Unique-violation race: another request registered this email between our
    // existence check and the insert.
    const pgErr = ((err as { cause?: unknown })?.cause ?? err) as { code?: string; constraint?: string };
    if (pgErr?.code === "23505" && String(pgErr.constraint ?? "").includes("email")) {
      res.status(400).json({ message: "Email already registered" });
      return;
    }
    req.log.error({ err }, "Register error");
    res.status(500).json({ message: "Registration failed" });
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

    if (user.twoFAEnabled && user.twoFASecret) {
      if (!totpCode) { res.status(200).json({ requires2FA: true }); return; }

      // Try TOTP first, then (single-use) backup codes
      if (!(await verifySecondFactor({ id: user.id, twoFASecret: user.twoFASecret }, totpCode))) {
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
      if (!(await verifySecondFactor({ id: user.id, twoFASecret: user.twoFASecret }, totpCode))) {
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

    await db.update(usersTable).set({
      twoFASecret: secret,
      twoFABackupCodes: JSON.stringify(backupCodesHashed),
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
    const isValid = authenticator.verify({ token: parsed.data.code, secret: user.twoFASecret });
    if (!isValid) { res.status(400).json({ message: "Invalid code" }); return; }
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
