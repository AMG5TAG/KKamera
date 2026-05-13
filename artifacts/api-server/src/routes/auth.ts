import { Router } from "express";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "@otplib/preset-default";
import QRCode from "qrcode";
import { db } from "@workspace/db";
import { usersTable, subscriptionsTable, referralsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, JWT_SECRET } from "../middlewares/auth.js";
import { sendEmail, welcomeEmail } from "../lib/email.js";

const router = Router();

function generateReferralCode(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6).padEnd(3, "K");
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${clean}${rand}`;
}

router.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name, referralCode } = req.body as {
      email: string; password: string; name: string; referralCode?: string;
    };
    if (!email || !password || !name) {
      res.status(400).json({ message: "Email, password and name are required" });
      return;
    }
    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      res.status(400).json({ message: "Email already registered" });
      return;
    }
    const passwordHash = await bcryptjs.hash(password, 12);
    const myReferralCode = generateReferralCode(name);

    let referrerId: number | undefined;
    if (referralCode) {
      const referrer = await db.select().from(usersTable).where(eq(usersTable.referralCode, referralCode)).limit(1);
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
      await db.insert(referralsTable).values({
        referrerId, referredId: user.id, referredName: name, status: "completed",
      });

      // Check if referrer has hit a new 5-referral milestone → award 1 free year
      try {
        const completedReferrals = await db
          .select()
          .from(referralsTable)
          .where(and(eq(referralsTable.referrerId, referrerId), eq(referralsTable.status, "completed")));
        const total = completedReferrals.length;
        if (total > 0 && total % 5 === 0) {
          const [referrerSub] = await db
            .select()
            .from(subscriptionsTable)
            .where(eq(subscriptionsTable.userId, referrerId))
            .limit(1);
          const base = referrerSub?.currentPeriodEnd && referrerSub.currentPeriodEnd > new Date()
            ? referrerSub.currentPeriodEnd
            : new Date();
          const newEnd = new Date(base);
          newEnd.setFullYear(newEnd.getFullYear() + 1);
          if (referrerSub) {
            await db.update(subscriptionsTable)
              .set({ status: "active", currentPeriodEnd: newEnd })
              .where(eq(subscriptionsTable.userId, referrerId));
          } else {
            await db.insert(subscriptionsTable).values({
              userId: referrerId, status: "active", currentPeriodEnd: newEnd,
            });
          }
        }
      } catch (affiliateErr) {
        req.log.warn({ affiliateErr }, "Affiliate reward check failed — continuing");
      }
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });

    // Send welcome email — fire and forget, never block the response
    const welcome = welcomeEmail(name);
    sendEmail({ to: email, ...welcome }).catch(() => {});

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled, createdAt: user.createdAt.toISOString() },
    });
  } catch (err) {
    req.log.error({ err }, "Register error");
    res.status(500).json({ message: "Registration failed" });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password, totpCode } = req.body as { email: string; password: string; totpCode?: string };
    if (!email || !password) { res.status(400).json({ message: "Email and password required" }); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user) { res.status(401).json({ message: "Invalid credentials" }); return; }

    const valid = await bcryptjs.compare(password, user.passwordHash);
    if (!valid) { res.status(401).json({ message: "Invalid credentials" }); return; }

    if (user.twoFAEnabled && user.twoFASecret) {
      if (!totpCode) { res.status(200).json({ requires2FA: true }); return; }
      const isValid = authenticator.verify({ token: totpCode, secret: user.twoFASecret });
      if (!isValid) { res.status(401).json({ message: "Invalid 2FA code" }); return; }
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled, createdAt: user.createdAt.toISOString() },
    });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ message: "Login failed" });
  }
});

router.post("/auth/logout", (_req, res) => {
  res.json({ message: "Logged out" });
});

router.post("/auth/2fa/setup", requireAuth, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    await db.update(usersTable).set({ twoFASecret: secret }).where(eq(usersTable.id, req.userId!));
    const otpauth = authenticator.keyuri(user.email, "KKamera", secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);
    const backupCodes = Array.from({ length: 8 }, () => Math.random().toString(36).substring(2, 10).toUpperCase());
    res.json({ secret, qrCodeUrl, backupCodes });
  } catch (err) {
    req.log.error({ err }, "2FA setup error");
    res.status(500).json({ message: "2FA setup failed" });
  }
});

router.post("/auth/2fa/verify", requireAuth, async (req, res) => {
  try {
    const { code } = req.body as { code: string };
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user?.twoFASecret) { res.status(400).json({ message: "2FA not set up" }); return; }
    const isValid = authenticator.verify({ token: code, secret: user.twoFASecret });
    if (!isValid) { res.status(400).json({ message: "Invalid code" }); return; }
    await db.update(usersTable).set({ twoFAEnabled: true }).where(eq(usersTable.id, req.userId!));
    res.json({ message: "2FA enabled successfully" });
  } catch (err) {
    req.log.error({ err }, "2FA verify error");
    res.status(500).json({ message: "2FA verification failed" });
  }
});

router.post("/auth/2fa/disable", requireAuth, async (req, res) => {
  try {
    const { code } = req.body as { code: string };
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user?.twoFAEnabled || !user.twoFASecret) { res.status(400).json({ message: "2FA not enabled" }); return; }
    const isValid = authenticator.verify({ token: code, secret: user.twoFASecret });
    if (!isValid) { res.status(400).json({ message: "Invalid code" }); return; }
    await db.update(usersTable).set({ twoFAEnabled: false, twoFASecret: null }).where(eq(usersTable.id, req.userId!));
    res.json({ message: "2FA disabled" });
  } catch (err) {
    req.log.error({ err }, "2FA disable error");
    res.status(500).json({ message: "2FA disable failed" });
  }
});

export default router;
