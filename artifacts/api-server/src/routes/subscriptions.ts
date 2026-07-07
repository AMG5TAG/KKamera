import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, usersTable, trialHistoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { emailTrialHash } from "../lib/emailHash.js";

// Billing is IAP-only (App Store / Play via RevenueCat). Purchases, renewals and
// cancellations happen store-side and are mirrored into subscriptionsTable by the
// RevenueCat webhook (routes/revenuecat.ts). These endpoints only read local
// state and start the 14-day trial; there is no server-side checkout/cancel.

const router = Router();

router.get("/subscriptions/me", requireAuth, async (req, res) => {
  try {
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, req.userId!)).limit(1);
    if (!sub) {
      res.json({ id: 0, userId: req.userId!, status: "none", trialEnd: null, currentPeriodEnd: null, createdAt: new Date().toISOString() });
      return;
    }
    res.json({
      id: sub.id, userId: sub.userId, status: sub.status,
      trialEnd: sub.trialEnd?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      createdAt: sub.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Get subscription error");
    res.status(500).json({ message: "Failed to get subscription" });
  }
});

router.post("/subscriptions/trial", requireAuth, async (req, res) => {
  try {
    const existing = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, req.userId!)).limit(1);
    if (existing.length > 0) {
      const sub = existing[0]!;
      res.json({ id: sub.id, userId: sub.userId, status: sub.status, trialEnd: sub.trialEnd?.toISOString() ?? null, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, createdAt: sub.createdAt.toISOString() });
      return;
    }
    // Only grant a trial if this email has never had one (see trial_history).
    const [u] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    const emailHash = u ? emailTrialHash(u.email) : null;
    const prior = emailHash
      ? await db.select({ id: trialHistoryTable.id }).from(trialHistoryTable).where(eq(trialHistoryTable.emailHash, emailHash)).limit(1)
      : [];
    if (prior.length > 0) {
      const [sub] = await db.insert(subscriptionsTable).values({ userId: req.userId!, status: "none" }).returning();
      res.json({ id: sub?.id ?? 0, userId: req.userId!, status: "none", trialEnd: null, currentPeriodEnd: null, createdAt: (sub?.createdAt ?? new Date()).toISOString() });
      return;
    }

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    const [sub] = await db.insert(subscriptionsTable).values({ userId: req.userId!, status: "trial", trialStart: new Date(), trialEnd }).returning();
    if (!sub) { res.status(500).json({ message: "Failed to start trial" }); return; }
    if (emailHash) await db.insert(trialHistoryTable).values({ emailHash }).onConflictDoNothing();
    res.json({ id: sub.id, userId: sub.userId, status: sub.status, trialEnd: sub.trialEnd?.toISOString() ?? null, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, createdAt: sub.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Start trial error");
    res.status(500).json({ message: "Failed to start trial" });
  }
});

export default router;
