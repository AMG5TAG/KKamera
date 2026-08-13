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

// Per-user cap on total invite recipients, enforced in the DB under a row lock.
// The per-IP limiter above is bypassable by rotating IPs; this is keyed to the
// authenticated account, so one user can't relay spam/phishing at scale.
const INVITE_WINDOW_MS = 24 * 60 * 60 * 1000;
const INVITE_CAP_PER_WINDOW = 50; // recipients per user per 24h

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

    if (emails.length === 0) {
      res.json({ message: "Invites sent to 0 contacts" });
      return;
    }

    // Atomically reserve capacity against the per-user window so concurrent
    // requests and separate autoscale instances share one counter.
    const reservation = await db.transaction(async (tx) => {
      const [row] = await tx.select({
        windowStart: usersTable.inviteWindowStart,
        used: usersTable.inviteCount,
      }).from(usersTable).where(eq(usersTable.id, req.userId!)).for("update").limit(1);
      if (!row) return { ok: false as const, remaining: 0 };

      const now = Date.now();
      const windowActive = !!(row.windowStart && now - row.windowStart.getTime() < INVITE_WINDOW_MS);
      const used = windowActive ? row.used : 0;
      if (used + emails.length > INVITE_CAP_PER_WINDOW) {
        return { ok: false as const, remaining: Math.max(0, INVITE_CAP_PER_WINDOW - used) };
      }
      await tx.update(usersTable).set({
        inviteWindowStart: windowActive ? row.windowStart : new Date(now),
        inviteCount: used + emails.length,
      }).where(eq(usersTable.id, req.userId!));
      return { ok: true as const, remaining: INVITE_CAP_PER_WINDOW - used - emails.length };
    });

    if (!reservation.ok) {
      res.status(429).json({
        message: `Daily invite limit reached — up to ${INVITE_CAP_PER_WINDOW} invites per day (${reservation.remaining} remaining). Try again later.`,
      });
      return;
    }

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
