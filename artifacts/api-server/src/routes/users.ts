import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  usersTable, subscriptionsTable, referralsTable,
  cloudConnectionsTable, uploadsTable, feedbackTable,
  passwordResetTokensTable,
} from "@workspace/db";
import { eq, and, ne, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { buildUserExport, parseTargetIds } from "../lib/accountRules.js";

const router = Router();

const updateMeSchema = z.object({
  // Trimmed so a whitespace-only name is rejected; null (allowed by the spec) = no change.
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters").nullish(),
  onboardingCompleted: z.boolean().optional(),
}).strict();

const uploadTargetSchema = z.object({
  mode: z.enum(["all", "selected", "none"]),
  connectionIds: z.array(z.number().int().positive()).max(50).optional(),
}).strict();

router.get("/users/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({
      id: user.id, email: user.email, name: user.name,
      referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled,
      onboardingCompleted: user.onboardingCompleted,
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
    const updates: Partial<{ name: string; onboardingCompleted: boolean }> = {};
    if (parsed.data.name != null) updates.name = parsed.data.name;
    if (parsed.data.onboardingCompleted !== undefined) updates.onboardingCompleted = parsed.data.onboardingCompleted;
    // Drizzle throws "No values to set" on an empty SET — that's a client error.
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: "Nothing to update" });
      return;
    }
    const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, req.userId!)).returning();
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({
      id: user.id, email: user.email, name: user.name,
      referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled,
      onboardingCompleted: user.onboardingCompleted,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Update me error");
    res.status(500).json({ message: "Failed to update user" });
  }
});

// ─── Upload target default ────────────────────────────────────────────────────
// Which connected cloud accounts a capture uploads to by default when the user
// has more than one: "all" active, a "selected" subset, or "none" (capture only).

router.get("/users/upload-target", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select({
      mode: usersTable.uploadTargetMode, ids: usersTable.uploadTargetIds,
    }).from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({ mode: user.mode, connectionIds: parseTargetIds(user.ids) });
  } catch (err) {
    req.log.error({ err }, "Get upload target error");
    res.status(500).json({ message: "Failed to get upload target" });
  }
});

router.put("/users/upload-target", requireAuth, async (req, res) => {
  try {
    const parsed = uploadTargetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { mode, connectionIds } = parsed.data;

    // Only persist ids that actually belong to this user, so a stale/foreign id
    // can never be stored or later uploaded to.
    let ownedIds: number[] = [];
    if (connectionIds?.length) {
      const owned = await db.select({ id: cloudConnectionsTable.id })
        .from(cloudConnectionsTable)
        .where(and(
          eq(cloudConnectionsTable.userId, req.userId!),
          inArray(cloudConnectionsTable.id, connectionIds),
        ));
      const ownedSet = new Set(owned.map(c => c.id));
      ownedIds = connectionIds.filter(id => ownedSet.has(id));
    }

    await db.update(usersTable).set({
      uploadTargetMode: mode,
      uploadTargetIds: ownedIds.length ? ownedIds.join(",") : null,
    }).where(eq(usersTable.id, req.userId!));

    res.json({ mode, connectionIds: ownedIds });
  } catch (err) {
    req.log.error({ err }, "Set upload target error");
    res.status(500).json({ message: "Failed to set upload target" });
  }
});

// GDPR: export all personal data
router.get("/users/me/export", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    // Every query is scoped to this user, and only non-secret columns are
    // selected (no password/TOTP hashes, tokens or encrypted credentials).
    const [user, subscriptions, cloudConnections, referralsMade, referredBy, uploads, feedback] = await Promise.all([
      db.select({
        id: usersTable.id, email: usersTable.email, name: usersTable.name,
        referralCode: usersTable.referralCode, twoFAEnabled: usersTable.twoFAEnabled,
        onboardingCompleted: usersTable.onboardingCompleted,
        uploadTargetMode: usersTable.uploadTargetMode, uploadTargetIds: usersTable.uploadTargetIds,
        createdAt: usersTable.createdAt,
      }).from(usersTable).where(eq(usersTable.id, userId)).limit(1),
      db.select({
        status: subscriptionsTable.status, trialStart: subscriptionsTable.trialStart,
        trialEnd: subscriptionsTable.trialEnd, currentPeriodEnd: subscriptionsTable.currentPeriodEnd,
        freeYearsAwarded: subscriptionsTable.freeYearsAwarded, createdAt: subscriptionsTable.createdAt,
      }).from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId)).limit(1),
      db.select({
        id: cloudConnectionsTable.id, type: cloudConnectionsTable.type, provider: cloudConnectionsTable.provider,
        name: cloudConnectionsTable.name, host: cloudConnectionsTable.host, port: cloudConnectionsTable.port,
        username: cloudConnectionsTable.username, uploadPath: cloudConnectionsTable.uploadPath,
        accountLabel: cloudConnectionsTable.accountLabel, active: cloudConnectionsTable.active,
        createdAt: cloudConnectionsTable.createdAt,
      }).from(cloudConnectionsTable).where(eq(cloudConnectionsTable.userId, userId)),
      db.select({
        id: referralsTable.id, referredName: referralsTable.referredName,
        status: referralsTable.status, createdAt: referralsTable.createdAt,
      }).from(referralsTable).where(eq(referralsTable.referrerId, userId)),
      db.select({ id: referralsTable.id, status: referralsTable.status, createdAt: referralsTable.createdAt })
        .from(referralsTable).where(eq(referralsTable.referredId, userId)),
      db.select({ id: uploadsTable.id, fileName: uploadsTable.fileName, fileType: uploadsTable.fileType, status: uploadsTable.status, createdAt: uploadsTable.createdAt })
        .from(uploadsTable).where(eq(uploadsTable.userId, userId)),
      db.select({ id: feedbackTable.id, type: feedbackTable.type, message: feedbackTable.message, createdAt: feedbackTable.createdAt })
        .from(feedbackTable).where(eq(feedbackTable.userId, userId)),
    ]);

    const u = user[0];
    if (!u) { res.status(404).json({ message: "User not found" }); return; }

    res.json(buildUserExport({
      user: u,
      subscription: subscriptions[0] ?? null,
      cloudConnections, referralsMade, referredBy, uploads, feedback,
    }, new Date()));
  } catch (err) {
    req.log.error({ err }, "Export data error");
    res.status(500).json({ message: "Failed to export data" });
  }
});

// GDPR: delete account and all associated data
router.delete("/users/me", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;

    // Billing is IAP-only; the user cancels the subscription store-side (App Store
    // / Play). Deleting the account here just removes our data — RevenueCat stops
    // mirroring once the store subscription lapses.

    // Delete all PII atomically — a partial delete must not leave orphaned rows
    // (e.g. encrypted cloud credentials) behind if one statement fails.
    await db.transaction(async (tx) => {
      await tx.delete(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, userId));
      await tx.delete(feedbackTable).where(eq(feedbackTable.userId, userId));
      await tx.delete(uploadsTable).where(eq(uploadsTable.userId, userId));
      await tx.delete(cloudConnectionsTable).where(eq(cloudConnectionsTable.userId, userId));
      await tx.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
      await tx.delete(referralsTable).where(eq(referralsTable.referrerId, userId));
      // Rows where this user was the one referred: a completed referral still
      // counts toward the referrer's free-year milestone (deleting it would
      // silently undo credit already earned), so anonymise it; pending/void rows
      // carry no credit and are deleted outright.
      await tx.update(referralsTable)
        .set({ referredName: "Deleted user" })
        .where(and(eq(referralsTable.referredId, userId), eq(referralsTable.status, "completed")));
      await tx.delete(referralsTable)
        .where(and(eq(referralsTable.referredId, userId), ne(referralsTable.status, "completed")));
      await tx.delete(usersTable).where(eq(usersTable.id, userId));
    });

    res.json({ message: "Account and all associated data deleted." });
  } catch (err) {
    req.log.error({ err }, "Delete account error");
    res.status(500).json({ message: "Failed to delete account" });
  }
});

export default router;
