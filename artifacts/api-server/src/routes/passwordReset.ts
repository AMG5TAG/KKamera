import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import bcryptjs from "bcryptjs";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { usersTable, passwordResetTokensTable } from "@workspace/db";
import { eq, and, gt, lt, isNull, count, sql } from "drizzle-orm";
import { sendEmail, escapeHtml, EMAIL_BRAND_FOOTER } from "../lib/email.js";
import { getPublicBaseUrl } from "../lib/appUrl.js";
import { grantTrialIfEligible, invalidateUnusedVerifications } from "../lib/emailVerificationStore.js";
import {
  newPasswordSchema, normalizedEmailSchema, RESET_EMAILS_PER_WINDOW, RESET_EMAIL_WINDOW_MS,
} from "../lib/accountRules.js";

const router = Router();

// Unauthenticated + email-sending / token-guessing endpoints — rate limit per IP
// so they can't be used to email-bomb a victim, burn Resend quota, or brute-force
// reset tokens.
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many password reset requests. Please try again in an hour." },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
});

const GENERIC_FORGOT_RESPONSE = "If an account with that email exists, a reset link has been sent.";

const forgotSchema = z.object({
  // Match the normalisation applied at register/login so a reset lookup finds
  // the account regardless of the case/whitespace the user types.
  email: normalizedEmailSchema,
});

const resetSchema = z.object({
  token: z.string().min(1, "Token is required"),
  // Shared rule: min 8 chars, max 72 BYTES (bcrypt's truncation limit).
  password: newPasswordSchema,
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

router.post("/auth/forgot-password", forgotPasswordLimiter, (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);

  // Respond identically and BEFORE any account-dependent work. Doing the lookup /
  // token write / email send after the response (fire-and-forget) means the
  // response latency is the same whether or not the email is registered — closing
  // the timing side-channel that would otherwise reveal account existence despite
  // the constant response body.
  res.json({ message: GENERIC_FORGOT_RESPONSE });

  if (!parsed.success) return;
  const { email } = parsed.data;

  void (async () => {
    try {
      const [user] = await db
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (!user) return;

      const token = randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

      // Per-account throttle (the per-IP limiter can't stop a distributed
      // email-bomb of one victim): at most RESET_EMAILS_PER_WINDOW links per
      // hour. Superseded tokens are voided (usedAt set) rather than deleted so
      // they still count. The user row lock serialises concurrent requests so
      // they can't all pass the count. Beyond the cap this silently no-ops —
      // the response above is already sent and identical either way.
      const issued = await db.transaction(async (tx) => {
        await tx.select({ id: usersTable.id }).from(usersTable)
          .where(eq(usersTable.id, user.id)).for("update");
        const [recent] = await tx.select({ n: count() }).from(passwordResetTokensTable)
          .where(and(
            eq(passwordResetTokensTable.userId, user.id),
            gt(passwordResetTokensTable.createdAt, new Date(now.getTime() - RESET_EMAIL_WINDOW_MS)),
          ));
        if ((recent?.n ?? 0) >= RESET_EMAILS_PER_WINDOW) return false;

        // Invalidate any existing unused tokens for this user
        await tx.update(passwordResetTokensTable)
          .set({ usedAt: now })
          .where(and(
            eq(passwordResetTokensTable.userId, user.id),
            isNull(passwordResetTokensTable.usedAt),
          ));
        // Housekeeping: old rows no longer matter for the throttle window.
        await tx.delete(passwordResetTokensTable)
          .where(and(
            eq(passwordResetTokensTable.userId, user.id),
            lt(passwordResetTokensTable.createdAt, new Date(now.getTime() - 24 * RESET_EMAIL_WINDOW_MS)),
          ));
        await tx.insert(passwordResetTokensTable).values({ userId: user.id, tokenHash, expiresAt });
        return true;
      });
      if (!issued) {
        req.log.warn({ userId: user.id }, "Password reset email suppressed (per-account limit)");
        return;
      }

      const resetUrl = `${getPublicBaseUrl()}/auth/reset-password?token=${token}`;
      await sendEmail({
        to: email,
        subject: "Reset your KKamera password",
        html: passwordResetEmail(user.name, resetUrl).html,
      }).catch(() => {});
    } catch (err: any) {
      req.log.error({ err }, "Forgot password background error");
    }
  })();
});

router.post("/auth/reset-password", resetPasswordLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
    return;
  }

  const { token, password } = parsed.data;
  const tokenHash = hashToken(token);

  try {
    // Hash first so the transaction below stays short (bcrypt is ~250ms).
    const passwordHash = await bcryptjs.hash(password, 12);

    // Consume the token atomically: a single conditional UPDATE ... RETURNING
    // means two concurrent requests with the same token can't both succeed, and
    // the password write commits (or rolls back) together with the consumption.
    const userId = await db.transaction(async (tx) => {
      const now = new Date();
      const [consumed] = await tx
        .update(passwordResetTokensTable)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResetTokensTable.tokenHash, tokenHash),
            isNull(passwordResetTokensTable.usedAt),
            gt(passwordResetTokensTable.expiresAt, now)
          )
        )
        .returning({ userId: passwordResetTokensTable.userId });
      if (!consumed) return null;

      const [before] = await tx.select({ emailVerifiedAt: usersTable.emailVerifiedAt })
        .from(usersTable).where(eq(usersTable.id, consumed.userId)).for("update").limit(1);
      const [updated] = await tx.update(usersTable)
        .set({
          passwordHash,
          passwordChangedAt: now,
          // Revoke every session and clear any sign-in lockout: the owner has
          // just proven control of the mailbox.
          tokenVersion: sql`${usersTable.tokenVersion} + 1`,
          failedLoginCount: 0,
          loginLockedUntil: null,
          // Following an emailed link proves the address too.
          emailVerifiedAt: before?.emailVerifiedAt ?? now,
        })
        .where(eq(usersTable.id, consumed.userId))
        .returning({ id: usersTable.id, email: usersTable.email });
      // Pending verification codes may carry another registration's password —
      // they must not be able to overwrite the one just set.
      await invalidateUnusedVerifications(tx, consumed.userId, now);
      // First proof of the address: start the free trial if the mailbox never had one.
      if (updated && before && !before.emailVerifiedAt) await grantTrialIfEligible(tx, updated);
      return consumed.userId;
    });

    if (userId === null) {
      res.status(400).json({ message: "Reset link is invalid or has expired. Request a new one." });
      return;
    }

    res.json({ message: "Password updated successfully. You can now sign in." });
  } catch (err: any) {
    req.log.error({ err }, "Reset password error");
    res.status(500).json({ message: "Failed to reset password" });
  }
});

function passwordResetEmail(name: string, resetUrl: string): { html: string } {
  return {
    html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0b08; color: #ccc; margin: 0; padding: 0; }
  .outer { max-width: 560px; margin: 40px auto; padding: 0 20px; }
  .logo { font-size: 24px; font-weight: 700; color: #b19870; margin-bottom: 32px; }
  .card { background: #1a1710; border-radius: 16px; padding: 32px; border: 1px solid rgba(177,152,112,0.2); }
  h1 { color: #ffffff; font-size: 22px; margin: 0 0 16px; }
  p { color: #aaa; font-size: 15px; line-height: 24px; margin: 0 0 16px; }
  .btn { display: inline-block; background: #b19870; color: white; text-decoration: none; font-size: 15px; font-weight: 600; padding: 14px 28px; border-radius: 12px; margin: 16px 0; }
  .footer { color: #444; font-size: 12px; text-align: center; margin-top: 32px; line-height: 20px; }
  .warn { color: #888; font-size: 13px; }
</style></head>
<body>
  <div class="outer">
    <div class="logo">KKamera</div>
    <div class="card">
      <h1>Reset your password</h1>
      <p>Hi ${escapeHtml(name)},</p>
      <p>We received a request to reset your KKamera password. Click the button below — this link expires in <strong style="color:#b19870">1 hour</strong>.</p>
      <a href="${resetUrl}" class="btn">Reset Password</a>
      <p class="warn">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
    </div>
    <div class="footer">KKamera &mdash; Cloud Based Photography<br>
    Questions? <a href="mailto:development@koastal.com.au" style="color:#b19870">development@koastal.com.au</a><br>
    ${EMAIL_BRAND_FOOTER}</div>
  </div>
</body>
</html>`,
  };
}

export default router;
