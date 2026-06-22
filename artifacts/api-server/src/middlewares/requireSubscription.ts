import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { SUBSCRIPTION_STATUS } from "../lib/constants.js";

/** Blocks the request if the user has no active subscription or trial. */
export async function requireSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, req.userId!))
      .limit(1);

    if (!sub) {
      res.status(402).json({ message: "No active subscription. Start a trial or subscribe to upload." });
      return;
    }

    const now = new Date();

    if (sub.status === SUBSCRIPTION_STATUS.TRIAL) {
      // A trial with no end date is untrusted — deny rather than grant unlimited
      // free access (e.g. a row left in "trial" by a webhook without a trialEnd).
      if (!sub.trialEnd || sub.trialEnd < now) {
        res.status(402).json({ message: "Your trial has expired. Subscribe to continue uploading." });
        return;
      }
      return next();
    }

    if (sub.status === SUBSCRIPTION_STATUS.ACTIVE) {
      // An active row with no period end is untrusted (e.g. an activation that
      // raced the Stripe fetch) — deny rather than grant perpetual free access.
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd < now) {
        res.status(402).json({ message: "Your subscription has expired. Renew to continue uploading." });
        return;
      }
      return next();
    }

    // Cancelled (auto-renew off): keep access until the period/trial already paid
    // for actually elapses, then deny.
    if (sub.status === SUBSCRIPTION_STATUS.CANCELLED) {
      const accessUntil = sub.currentPeriodEnd ?? sub.trialEnd;
      if (accessUntil && accessUntil > now) {
        return next();
      }
      res.status(402).json({ message: "Your subscription has ended. Resubscribe to continue uploading." });
      return;
    }

    // past_due: allow access (Stripe handles collection), but warn
    if (sub.status === SUBSCRIPTION_STATUS.PAST_DUE) {
      return next();
    }

    res.status(402).json({ message: "Your subscription is not active. Subscribe to continue uploading." });
  } catch (err) {
    req.log.error({ err }, "Subscription check failed");
    res.status(500).json({ message: "Failed to verify subscription" });
  }
}
