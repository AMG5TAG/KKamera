import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import bcryptjs from "bcryptjs";
import { z } from "zod";
import { db } from "@workspace/db";
import { usersTable, passwordResetTokensTable } from "@workspace/db";
import { eq, and, gt, isNull } from "drizzle-orm";
import { sendEmail, escapeHtml } from "../lib/email.js";
import { getPublicBaseUrl } from "../lib/appUrl.js";

const router = Router();

const forgotSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const resetSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

router.post("/auth/forgot-password", async (req, res) => {
  // Always respond 200 to avoid email enumeration
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ message: "If an account with that email exists, a reset link has been sent." });
    return;
  }

  const { email } = parsed.data;

  try {
    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    if (user) {
      const token = randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any existing unused tokens for this user
      await db
        .delete(passwordResetTokensTable)
        .where(
          and(
            eq(passwordResetTokensTable.userId, user.id),
            isNull(passwordResetTokensTable.usedAt)
          )
        );

      await db.insert(passwordResetTokensTable).values({
        userId: user.id,
        tokenHash,
        expiresAt,
      });

      const resetUrl = `${getPublicBaseUrl()}/auth/reset-password?token=${token}`;
      await sendEmail({
        to: email,
        subject: "Reset your KKamera password",
        html: passwordResetEmail(user.name, resetUrl).html,
      }).catch(() => {});
    }

    res.json({ message: "If an account with that email exists, a reset link has been sent." });
  } catch (err: any) {
    req.log.error({ err }, "Forgot password error");
    res.json({ message: "If an account with that email exists, a reset link has been sent." });
  }
});

router.post("/auth/reset-password", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
    return;
  }

  const { token, password } = parsed.data;
  const tokenHash = hashToken(token);

  try {
    const [record] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.tokenHash, tokenHash),
          isNull(passwordResetTokensTable.usedAt),
          gt(passwordResetTokensTable.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!record) {
      res.status(400).json({ message: "Reset link is invalid or has expired. Request a new one." });
      return;
    }

    const passwordHash = await bcryptjs.hash(password, 12);

    await Promise.all([
      db.update(usersTable).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(usersTable.id, record.userId)),
      db
        .update(passwordResetTokensTable)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokensTable.id, record.id)),
    ]);

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
    Questions? <a href="mailto:support@kkamera.app" style="color:#b19870">support@kkamera.app</a></div>
  </div>
</body>
</html>`,
  };
}

export default router;
