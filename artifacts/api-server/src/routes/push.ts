import { Router } from "express";
import { db } from "@workspace/db";
import { pushSubscriptionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

/** Return the VAPID public key so the client can subscribe */
router.get("/push/vapid-key", (_req, res) => {
  const publicKey = process.env["VAPID_PUBLIC_KEY"];
  if (!publicKey) {
    res.status(503).json({ message: "Push notifications not configured" });
    return;
  }
  res.json({ publicKey });
});

/** Register a push subscription for the authenticated user */
router.post("/push/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ message: "endpoint and keys (p256dh, auth) are required" });
      return;
    }

    const userAgent = req.headers["user-agent"]?.slice(0, 500) ?? null;

    // Upsert: replace existing subscription for this endpoint
    await db
      .insert(pushSubscriptionsTable)
      .values({ userId: req.userId!, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent })
      .onConflictDoUpdate({
        target: pushSubscriptionsTable.endpoint,
        set: { userId: req.userId!, p256dh: keys.p256dh, auth: keys.auth, userAgent },
      });

    res.status(201).json({ message: "Subscribed" });
  } catch (err) {
    req.log.error({ err }, "Push subscribe error");
    res.status(500).json({ message: "Failed to save push subscription" });
  }
});

/** Remove a push subscription (unsubscribe) */
router.post("/push/unsubscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body as { endpoint: string };
    if (!endpoint) {
      res.status(400).json({ message: "endpoint is required" });
      return;
    }
    await db
      .delete(pushSubscriptionsTable)
      .where(and(
        eq(pushSubscriptionsTable.userId, req.userId!),
        eq(pushSubscriptionsTable.endpoint, endpoint)
      ));
    res.json({ message: "Unsubscribed" });
  } catch (err) {
    req.log.error({ err }, "Push unsubscribe error");
    res.status(500).json({ message: "Failed to remove push subscription" });
  }
});

/** Check if the current user has any active push subscriptions */
router.get("/push/status", requireAuth, async (req, res) => {
  try {
    const subs = await db
      .select({ id: pushSubscriptionsTable.id })
      .from(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.userId, req.userId!));
    res.json({ subscribed: subs.length > 0, count: subs.length });
  } catch (err) {
    req.log.error({ err }, "Push status error");
    res.status(500).json({ message: "Failed to get push status" });
  }
});

export default router;
