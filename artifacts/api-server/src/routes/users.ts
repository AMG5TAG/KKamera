import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  usersTable, subscriptionsTable, referralsTable,
  cloudConnectionsTable, uploadsTable, feedbackTable,
  pushSubscriptionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { getUncachableStripeClient } from "../stripeClient.js";

const router = Router();

const updateMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
}).strict();

router.get("/users/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({
      id: user.id, email: user.email, name: user.name,
      referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Get me error");
    res.status(500).json({ message: "Failed to get user" });
  }
});

router.patch("/users/me", requireAuth, async (req, res) => {
  try {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const updates: Partial<{ name: string }> = {};
    if (parsed.data.name) updates.name = parsed.data.name;
    const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, req.userId!)).returning();
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({
      id: user.id, email: user.email, name: user.name,
      referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Update me error");
    res.status(500).json({ message: "Failed to update user" });
  }
});

// GDPR: export all personal data
router.get("/users/me/export", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const [user, subscriptions, referrals, uploads, feedback] = await Promise.all([
      db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1),
      db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId)),
      db.select().from(referralsTable).where(eq(referralsTable.referrerId, userId)),
      db.select({ id: uploadsTable.id, fileName: uploadsTable.fileName, fileType: uploadsTable.fileType, status: uploadsTable.status, createdAt: uploadsTable.createdAt })
        .from(uploadsTable).where(eq(uploadsTable.userId, userId)),
      db.select({ id: feedbackTable.id, type: feedbackTable.type, message: feedbackTable.message, createdAt: feedbackTable.createdAt })
        .from(feedbackTable).where(eq(feedbackTable.userId, userId)),
    ]);

    const u = user[0];
    if (!u) { res.status(404).json({ message: "User not found" }); return; }

    res.json({
      exportedAt: new Date().toISOString(),
      user: {
        id: u.id, email: u.email, name: u.name,
        referralCode: u.referralCode, twoFAEnabled: u.twoFAEnabled,
        createdAt: u.createdAt.toISOString(),
      },
      subscription: subscriptions[0] ?? null,
      referrals,
      uploads,
      feedback,
    });
  } catch (err) {
    req.log.error({ err }, "Export data error");
    res.status(500).json({ message: "Failed to export data" });
  }
});

// GDPR: delete account and all associated data
router.delete("/users/me", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;

    // Cancel any live Stripe subscription immediately so a deleted account is
    // not billed again. Best-effort — never block account deletion on Stripe.
    try {
      const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId)).limit(1);
      if (sub?.stripeSubscriptionId) {
        const stripe = await getUncachableStripeClient();
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      }
    } catch (err) {
      req.log.error({ err }, "Failed to cancel Stripe subscription during account deletion");
    }

    await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, userId));
    await db.delete(feedbackTable).where(eq(feedbackTable.userId, userId));
    await db.delete(uploadsTable).where(eq(uploadsTable.userId, userId));
    await db.delete(cloudConnectionsTable).where(eq(cloudConnectionsTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(referralsTable).where(eq(referralsTable.referrerId, userId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));

    res.json({ message: "Account and all associated data deleted." });
  } catch (err) {
    req.log.error({ err }, "Delete account error");
    res.status(500).json({ message: "Failed to delete account" });
  }
});

export default router;
