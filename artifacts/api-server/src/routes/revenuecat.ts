import { Router } from "express";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { allowSandboxIap, mapRevenueCatEvent } from "../lib/revenueCatMapping.js";
import { applyMirrorDecision, RevenueCatNotConfiguredError, syncUserFromRevenueCat } from "../lib/revenueCatApi.js";
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
 *
 * SANDBOX events are ignored unless ALLOW_SANDBOX_IAP=true, and even then never
 * complete or reverse referrals. Row writes go through applyMirrorDecision
 * (forward-only period ends, refunds pinned, no rows for deleted users).
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
    const decision = mapRevenueCatEvent(ev, Date.now(), { allowSandbox: allowSandboxIap() });

    switch (decision.kind) {
      case "grant":
      case "cancel":
      case "past_due":
      case "expire":
      case "refund": {
        const result = await applyMirrorDecision(decision.userId, decision);
        if (result === "no_user") {
          // Deleted account (or a foreign id) — ack without creating an orphan row.
          logger.info({ type: ev.type, userId: decision.userId }, "RevenueCat event for unknown user — ignored");
          break;
        }
        logger.info(
          { type: ev.type, userId: decision.userId, kind: decision.kind, result, sandbox: !decision.referrals },
          "RevenueCat event mirrored",
        );
        // Referrals move only on production events (sandbox never touches them).
        if (!decision.referrals) break;
        if (decision.kind === "grant") {
          // Complete a pending referral only when real money moved (price > 0) — a
          // store-side free trial (price 0) must not credit a referrer. Idempotent:
          // completeReferralForUser atomically claims the pending row, so renewals
          // won't re-complete it.
          if (Number((ev as any).price ?? (ev as any).price_in_purchased_currency ?? 0) > 0) {
            await completeReferralForUser(decision.userId);
          }
        } else if (decision.kind === "expire" || decision.kind === "refund") {
          // Claw back any referral reward earned from this lapsed/refunded subscription.
          await reverseReferralForUser(decision.userId);
        }
        break;
      }
      case "transfer": {
        // Purchases moved between app user ids. RevenueCat sends this only for
        // the destination, so re-read every affected user from the REST API
        // (best effort — a failure here must not make RevenueCat retry forever).
        const targets = [
          ...decision.toUserIds.map((id) => ({ id, revokeIfNone: false })),
          ...decision.fromUserIds
            .filter((id) => !decision.toUserIds.includes(id))
            .map((id) => ({ id, revokeIfNone: true })),
        ];
        for (const t of targets) {
          try {
            await syncUserFromRevenueCat(t.id, { revokeIfNone: t.revokeIfNone });
          } catch (err) {
            if (err instanceof RevenueCatNotConfiguredError) {
              logger.warn({ userId: t.id }, "RevenueCat TRANSFER not reconciled — REVENUECAT_SECRET_API_KEY unset");
            } else {
              logger.error({ err, userId: t.id }, "RevenueCat TRANSFER re-sync failed");
            }
          }
        }
        break;
      }
      default:
        // Anonymous purchase, non-pro entitlement, stale or sandbox event — ack so
        // RevenueCat stops retrying; the client reconciles via /subscriptions/sync.
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
