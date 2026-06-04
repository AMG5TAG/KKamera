import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { authenticator } from "@otplib/preset-default";
import QRCode from "qrcode";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, referralsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, JWT_SECRET } from "../middlewares/auth.js";
import { sendEmail, welcomeEmail } from "../lib/email.js";

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many registration attempts. Please try again in an hour." },
});

// ─── Validation schemas ────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1, "Name is required").max(100),
  referralCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
  totpCode: z.string().optional().nullable(),
});

const twoFACodeSchema = z.object({
  code: z.string().length(6, "Code must be 6 digits").regex(/^\d+$/, "Code must be numeric"),
});

const twoFAOrBackupSchema = z.object({
  code: z.string().min(1, "Code is required"),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateReferralCode(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6).padEnd(3, "K");
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${clean}${rand}`;
}

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
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
    if (referralCode) {
      const referrer = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.referralCode, referralCode)).limit(1);
      if (referrer.length > 0) referrerId = referrer[0]!.id;
    }

    const [user] = await db.insert(usersTable).values({
      email, passwordHash, name, referralCode: myReferralCode,
      referrerId: referrerId ?? null, twoFAEnabled: false,
    }).returning();

    if (!user) { res.status(500).json({ message: "Registration failed" }); return; }

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    await db.insert(subscriptionsTable).values({
      userId: user.id, status: "trial", trialStart: new Date(), trialEnd,
    });

    if (referrerId) {
      // Referral is "pending" until the referred user subscribes (completed via webhook)
      await db.insert(referralsTable).values({
        referrerId, referredId: user.id, referredName: name, status: "pending",
      });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });

    // Fire and forget — never block the response
    const welcome = welcomeEmail(name);
    sendEmail({ to: email, ...welcome }).catch(() => {});

    res.status(201).json({ token, user: formatUser(user) });
  } catch (err) {
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
    if (!user) { res.status(401).json({ message: "Invalid credentials" }); return; }

    const valid = await bcryptjs.compare(password, user.passwordHash);
    if (!valid) { res.status(401).json({ message: "Invalid credentials" }); return; }

    if (user.twoFAEnabled && user.twoFASecret) {
      if (!totpCode) { res.status(200).json({ requires2FA: true }); return; }

      // Try TOTP first, then backup codes
      const isTotpValid = authenticator.verify({ token: totpCode, secret: user.twoFASecret });
      if (!isTotpValid) {
        // Check backup codes
        const backupCodes: string[] = user.twoFABackupCodes ? JSON.parse(user.twoFABackupCodes) : [];
        const inputHash = hashBackupCode(totpCode.replace(/\s/g, "").toUpperCase());
        const matchIndex = backupCodes.indexOf(inputHash);
        if (matchIndex === -1) {
          res.status(401).json({ message: "Invalid 2FA code" });
          return;
        }
        // Consume the backup code (single use)
        backupCodes.splice(matchIndex, 1);
        await db.update(usersTable)
          .set({ twoFABackupCodes: JSON.stringify(backupCodes) })
          .where(eq(usersTable.id, user.id));
      }
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
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

// ─── 2FA Setup ────────────────────────────────────────────────────────────────

router.post("/auth/2fa/setup", requireAuth, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }

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

router.post("/auth/2fa/verify", requireAuth, async (req, res) => {
  try {
    const parsed = twoFACodeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid code" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user?.twoFASecret) { res.status(400).json({ message: "2FA not set up" }); return; }
    const isValid = authenticator.verify({ token: parsed.data.code, secret: user.twoFASecret });
    if (!isValid) { res.status(400).json({ message: "Invalid code" }); return; }
    await db.update(usersTable).set({ twoFAEnabled: true }).where(eq(usersTable.id, req.userId!));
    res.json({ message: "2FA enabled successfully" });
  } catch (err) {
    req.log.error({ err }, "2FA verify error");
    res.status(500).json({ message: "2FA verification failed" });
  }
});

// ─── 2FA Disable ──────────────────────────────────────────────────────────────

router.post("/auth/2fa/disable", requireAuth, async (req, res) => {
  try {
    const parsed = twoFAOrBackupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Code is required" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user?.twoFAEnabled || !user.twoFASecret) { res.status(400).json({ message: "2FA not enabled" }); return; }

    const isTotpValid = authenticator.verify({ token: parsed.data.code, secret: user.twoFASecret });
    if (!isTotpValid) {
      // Accept backup code to disable 2FA (recovery path)
      const backupCodes: string[] = user.twoFABackupCodes ? JSON.parse(user.twoFABackupCodes) : [];
      const inputHash = hashBackupCode(parsed.data.code.replace(/\s/g, "").toUpperCase());
      if (!backupCodes.includes(inputHash)) {
        res.status(400).json({ message: "Invalid code" });
        return;
      }
    }

    await db.update(usersTable).set({
      twoFAEnabled: false,
      twoFASecret: null,
      twoFABackupCodes: null,
    }).where(eq(usersTable.id, req.userId!));
    res.json({ message: "2FA disabled" });
  } catch (err) {
    req.log.error({ err }, "2FA disable error");
    res.status(500).json({ message: "2FA disable failed" });
  }
});

export default router;
