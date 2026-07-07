import { Router } from "express";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { subscriptionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { mapRevenueCatEvent } from "../lib/revenueCatMapping.js";
import { completeReferralForUser, reverseReferralForUser } from "../lib/referrals.js";

const router = Router();

/**
 * RevenueCat webhook — the server-side source of truth for App Store / Play IAP
 * subscriptions — the sole billing system for the native apps. Without this,
 * native subscribers have no `active` row and `requireSubscription` blocks their
 * uploads with 402 once the trial row expires, even though they are paying.
 *
 * The client links purchases to the KKamera account via `Purchases.logIn(userId)`,
 * so `event.app_user_id` is our numeric user id. Auth is a shared secret sent by
 * RevenueCat in the Authorization header (configure it in the RevenueCat
 * dashboard and as REVENUECAT_WEBHOOK_AUTH here) — the route fails closed if it
 * is unset, so an unconfigured deploy never trusts an unauthenticated caller.
 */

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

router.post("/revenuecat/webhook", async (req, res) => {
  const expected = process.env["REVENUECAT_WEBHOOK_AUTH"];
  if (!expected) {
    logger.warn("RevenueCat webhook hit but REVENUECAT_WEBHOOK_AUTH is unset — rejecting (fail closed)");
    res.status(503).json({ message: "RevenueCat webhook not configured" });
    return;
  }
  const provided = req.headers["authorization"];
  if (typeof provided !== "string" || !timingSafeEqualStr(provided, expected)) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const ev = (req.body as any)?.event;
  if (!ev || typeof ev.type !== "string") {
    res.status(400).json({ message: "Missing event" });
    return;
  }

  try {
    const decision = mapRevenueCatEvent(ev, Date.now());

    switch (decision.kind) {
      case "grant": {
        // Forward-only period end (GREATEST) guards against out-of-order delivery.
        await db.insert(subscriptionsTable)
          .values({ userId: decision.userId, status: "active", currentPeriodEnd: decision.periodEnd })
          .onConflictDoUpdate({
            target: subscriptionsTable.userId,
            set: {
              status: "active",
              currentPeriodEnd: sql`GREATEST(${subscriptionsTable.currentPeriodEnd}, ${decision.periodEnd})`,
            },
          });
        logger.info({ userId: decision.userId, periodEnd: decision.periodEnd }, "RevenueCat entitlement active");
        // Complete a pending referral only when real money moved (price > 0) — a
        // store-side free trial (price 0) must not credit a referrer. Idempotent:
        // completeReferralForUser atomically claims the pending row, so renewals
        // won't re-complete it.
        if (Number((ev as any).price ?? (ev as any).price_in_purchased_currency ?? 0) > 0) {
          await completeReferralForUser(decision.userId);
        }
        break;
      }
      case "cancel": {
        // Auto-renew off but access continues until expiration — mirror as cancelled
        // with the period end so evaluateAccess keeps them until it elapses.
        await db.insert(subscriptionsTable)
          .values({ userId: decision.userId, status: "cancelled", currentPeriodEnd: decision.periodEnd })
          .onConflictDoUpdate({
            target: subscriptionsTable.userId,
            set: {
              status: "cancelled",
              ...(decision.periodEnd ? { currentPeriodEnd: sql`GREATEST(${subscriptionsTable.currentPeriodEnd}, ${decision.periodEnd})` } : {}),
            },
          });
        logger.info({ userId: decision.userId, periodEnd: decision.periodEnd }, "RevenueCat cancelled (access until period end)");
        break;
      }
      case "past_due": {
        await db.update(subscriptionsTable)
          .set({ status: "past_due", ...(decision.periodEnd ? { currentPeriodEnd: sql`GREATEST(${subscriptionsTable.currentPeriodEnd}, ${decision.periodEnd})` } : {}) })
          .where(eq(subscriptionsTable.userId, decision.userId));
        logger.info({ userId: decision.userId }, "RevenueCat billing issue — past_due");
        break;
      }
      case "expire": {
        await db.update(subscriptionsTable)
          .set({ status: "expired" })
          .where(eq(subscriptionsTable.userId, decision.userId));
        logger.info({ userId: decision.userId }, "RevenueCat entitlement expired");
        // Claw back any referral reward earned from this now-lapsed subscription.
        await reverseReferralForUser(decision.userId);
        break;
      }
      default:
        // Anonymous purchase, non-pro entitlement, stale event, or TRANSFER — ack
        // so RevenueCat stops retrying; the client reconciles on next logIn.
        logger.info({ type: ev.type, reason: decision.reason }, "RevenueCat event acknowledged (no state change)");
    }

    res.status(200).json({ received: true });
  } catch (err) {
    // Return 5xx so RevenueCat retries rather than silently losing the update.
    req.log.error({ err }, "RevenueCat webhook processing failed");
    res.status(500).json({ message: "Webhook processing error" });
  }
});

export default router;
