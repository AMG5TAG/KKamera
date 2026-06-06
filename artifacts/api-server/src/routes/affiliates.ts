import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { usersTable, referralsTable, subscriptionsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { sendEmail, coworkerInviteEmail } from "../lib/email.js";

const router = Router();

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 invite batches/hour per IP — anti-spam
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many invites sent. Please try again later." },
});

const inviteSchema = z.object({
  emails: z.array(z.string().email("Invalid email address")).min(1, "Add at least one email").max(10, "Maximum 10 invites at a time"),
});

router.get("/affiliates/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }

    const allReferrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, req.userId!));
    const completed = allReferrals.filter(r => r.status === "completed");
    const yearsEarned = Math.floor(completed.length / 5);

    res.json({
      referralCode: user.referralCode,
      totalReferrals: allReferrals.length,
      completedReferrals: completed.length,
      yearsEarned,
    });
  } catch (err) {
    req.log.error({ err }, "Affiliate stats error");
    res.status(500).json({ message: "Failed to get affiliate stats" });
  }
});

router.get("/affiliates/referrals", requireAuth, async (req, res) => {
  try {
    const referrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, req.userId!));
    res.json(referrals.map(r => ({
      id: r.id,
      referredName: r.referredName,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Get referrals error");
    res.status(500).json({ message: "Failed to get referrals" });
  }
});

router.post("/affiliates/invite", requireAuth, inviteLimiter, async (req, res) => {
  try {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }

    const emails = [...new Set(parsed.data.emails.map(e => e.trim().toLowerCase()))]
      .filter(e => e !== user.email); // don't invite yourself

    const invite = coworkerInviteEmail(user.name, user.referralCode);
    // Fire all sends; sendEmail logs failures internally and never throws
    await Promise.all(emails.map(to => sendEmail({ to, ...invite })));

    res.json({ message: `Invites sent to ${emails.length} contact${emails.length !== 1 ? "s" : ""}` });
  } catch (err) {
    req.log.error({ err }, "Invite error");
    res.status(500).json({ message: "Failed to send invites" });
  }
});

export default router;
