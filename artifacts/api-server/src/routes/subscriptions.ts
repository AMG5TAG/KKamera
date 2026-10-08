import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { subscriptionsTable, usersTable, trialHistoryTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { emailTrialHashes } from "../lib/emailHash.js";
import { evaluateAccess } from "../lib/subscriptionAccess.js";
import { isTesterUser } from "../middlewares/requireSubscription.js";
import { RevenueCatNotConfiguredError, syncUserFromRevenueCat } from "../lib/revenueCatApi.js";

// Billing is IAP-only (App Store / Play via RevenueCat). Purchases, renewals and
// cancellations happen store-side and are mirrored into subscriptionsTable by the
// RevenueCat webhook (routes/revenuecat.ts). These endpoints only read local
// state and start the 24-hour trial; there is no server-side checkout/cancel.
// POST /subscriptions/sync reconciles from the RevenueCat REST API when the app
// knows a purchase/restore just happened (webhooks can lag or be missed).

const router = Router();

async function subscriptionJson(userId: number) {
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId)).limit(1);
  // Alpha testers (TESTER_EMAILS) whose own row doesn't grant access are shown
  // as active so the app unlocks the camera; requireSubscription lets them upload.
  if (!evaluateAccess(sub, new Date()).allow && await isTesterUser(userId)) {
    const now = new Date();
    return {
      id: sub?.id ?? 0, userId, status: "active", trialEnd: null,
      currentPeriodEnd: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      createdAt: (sub?.createdAt ?? now).toISOString(),
    };
  }
  if (!sub) {
    return { id: 0, userId, status: "none", trialEnd: null, currentPeriodEnd: null, createdAt: new Date().toISOString() };
  }
  return {
    id: sub.id, userId: sub.userId, status: sub.status,
    trialEnd: sub.trialEnd?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    createdAt: sub.createdAt.toISOString(),
  };
}

// Each sync is an outbound RevenueCat API call — cap it per user.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { message: "Too many subscription refreshes. Please try again shortly." },
});

router.get("/subscriptions/me", requireAuth, async (req, res) => {
  try {
    res.json(await subscriptionJson(req.userId!));
  } catch (err) {
    req.log.error({ err }, "Get subscription error");
    res.status(500).json({ message: "Failed to get subscription" });
  }
});

// Not used by the app (email verification grants the trial); kept as API surface.
// Race-safe: concurrent calls insert with ON CONFLICT (user_id) DO NOTHING and
// then read back whichever row won, instead of 500ing on the unique key.
router.post("/subscriptions/trial", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const [existing] = await db.select({ id: subscriptionsTable.id }).from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId)).limit(1);
    if (!existing) {
      // Only grant a trial if this email has never had one (see trial_history).
      const [u] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      // Check both the legacy hash and the alias-normalised one (Gmail dots, +tags).
      const emailHashes = u ? emailTrialHashes(u.email) : [];
      const prior = emailHashes.length > 0
        ? await db.select({ id: trialHistoryTable.id }).from(trialHistoryTable).where(inArray(trialHistoryTable.emailHash, emailHashes)).limit(1)
        : [];
      if (prior.length > 0) {
        await db.insert(subscriptionsTable).values({ userId, status: "none" })
          .onConflictDoNothing({ target: subscriptionsTable.userId });
      } else {
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 14);
        const inserted = await db.insert(subscriptionsTable)
          .values({ userId, status: "trial", trialStart: new Date(), trialEnd })
          .onConflictDoNothing({ target: subscriptionsTable.userId })
          .returning({ id: subscriptionsTable.id });
        // Record the trial only if this call actually granted it.
        if (inserted.length > 0 && emailHashes.length > 0) {
          await db.insert(trialHistoryTable).values(emailHashes.map(emailHash => ({ emailHash }))).onConflictDoNothing();
        }
      }
    }
    res.json(await subscriptionJson(userId));
  } catch (err) {
    req.log.error({ err }, "Start trial error");
    res.status(500).json({ message: "Failed to start trial" });
  }
});

router.post("/subscriptions/sync", requireAuth, syncLimiter, async (req, res) => {
  try {
    await syncUserFromRevenueCat(req.userId!);
    res.json(await subscriptionJson(req.userId!));
  } catch (err) {
    if (err instanceof RevenueCatNotConfiguredError) {
      req.log.warn("Subscription sync requested but REVENUECAT_SECRET_API_KEY is unset");
      res.status(503).json({ message: "Subscription sync is temporarily unavailable." });
      return;
    }
    req.log.error({ err }, "Subscription sync error");
    res.status(503).json({ message: "Couldn't reach the store to refresh your subscription. Please try again." });
  }
});

export default router;
