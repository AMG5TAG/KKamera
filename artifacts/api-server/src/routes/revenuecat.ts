import { Router } from "express";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { allowSandboxIap, eventIdOf, mapRevenueCatEvent, secretsEqual } from "../lib/revenueCatMapping.js";
import {
  applyMirrorDecisionInTx,
  claimRevenueCatEvent,
  isRevenueCatEventRecorded,
  pruneRevenueCatEvents,
  RevenueCatNotConfiguredError,
  syncUserFromRevenueCat,
} from "../lib/revenueCatApi.js";
import { completeReferralInTx, notifyReferralAward, reverseReferralInTx, type ReferralAward } from "../lib/referrals.js";

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
 * complete or reverse referrals. Row writes go through applyMirrorDecisionInTx
 * (forward-only period ends, refunds pinned, no rows for deleted users, events
 * older than subscriptions.last_event_at can't change status).
 *
 * Idempotency: RevenueCat retries reuse the event `id`. The id is recorded in
 * revenuecat_events in the SAME transaction as the mirror write and referral
 * change; a redelivery finds it and is acked without re-applying. Events ignored
 * by policy (anonymous, sandbox, non-pro, unknown user, stale expiration) are
 * recorded too — one cheap insert that makes a replay a single PK lookup and
 * leaves an audit trail of what was received. Events without an id are
 * processed as before (every step is idempotent on its own) with a warning.
 * TRANSFER does outbound REST calls, so it isn't run inside a transaction: the
 * re-sync (an idempotent snapshot) runs first and the id is recorded after.
 * Recorded ids are pruned after 90 days (at most once per hour per process).
 */

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneMs = 0;

/** Opportunistic retention cleanup of revenuecat_events (fire-and-forget). */
function maybePruneEvents(nowMs: number): void {
  if (nowMs - lastPruneMs < PRUNE_INTERVAL_MS) return;
  lastPruneMs = nowMs;
  pruneRevenueCatEvents()
    .then((n) => { if (n > 0) logger.info({ deleted: n }, "Pruned old RevenueCat event ids"); })
    .catch((err) => logger.warn({ err }, "RevenueCat event-id prune failed"));
}

router.post("/revenuecat/webhook", async (req, res) => {
  const expected = process.env["REVENUECAT_WEBHOOK_AUTH"];
  if (!expected) {
    logger.warn("RevenueCat webhook hit but REVENUECAT_WEBHOOK_AUTH is unset — rejecting (fail closed)");
    res.status(503).json({ message: "RevenueCat webhook not configured" });
    return;
  }
  const provided = req.headers["authorization"];
  if (typeof provided !== "string" || !secretsEqual(provided, expected)) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const ev = (req.body as any)?.event;
  if (!ev || typeof ev.type !== "string") {
    res.status(400).json({ message: "Missing event" });
    return;
  }

  const eventId = eventIdOf(ev);
  if (!eventId) logger.warn({ type: ev.type }, "RevenueCat event without an id — processing without idempotency record");

  try {
    const decision = mapRevenueCatEvent(ev, Date.now(), { allowSandbox: allowSandboxIap() });

    if (decision.kind === "transfer") {
      // Purchases moved between app user ids. RevenueCat sends this only for
      // the destination, so re-read every affected user from the REST API
      // (best effort — a failure here must not make RevenueCat retry forever).
      if (eventId && (await isRevenueCatEventRecorded(eventId))) {
        logger.info({ type: ev.type, eventId }, "RevenueCat event already processed — skipped");
      } else {
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
        if (eventId) await claimRevenueCatEvent(db, eventId, decision.toUserIds[0] ?? null, ev.type);
      }
      res.status(200).json({ received: true });
      maybePruneEvents(Date.now());
      return;
    }

    if (decision.kind === "ignore" && !eventId) {
      // Anonymous purchase, non-pro entitlement, stale or sandbox event — ack so
      // RevenueCat stops retrying; the client reconciles via /subscriptions/sync.
      logger.info({ type: ev.type, reason: decision.reason }, "RevenueCat event acknowledged (no state change)");
      res.status(200).json({ received: true });
      return;
    }

    const award = await db.transaction(async (tx): Promise<ReferralAward | null> => {
      if (eventId && !(await claimRevenueCatEvent(tx, eventId, decision.userId ?? null, ev.type))) {
        logger.info({ type: ev.type, eventId }, "RevenueCat event already processed — skipped");
        return null;
      }

      if (decision.kind === "ignore") {
        logger.info({ type: ev.type, eventId, reason: decision.reason }, "RevenueCat event acknowledged (no state change)");
        return null;
      }

      const result = await applyMirrorDecisionInTx(tx, decision.userId, decision);
      if (result === "no_user") {
        // Deleted account (or a foreign id) — ack without creating an orphan row.
        logger.info({ type: ev.type, eventId, userId: decision.userId }, "RevenueCat event for unknown user — ignored");
        return null;
      }
      logger.info(
        { type: ev.type, eventId, userId: decision.userId, kind: decision.kind, result, sandbox: !decision.referrals },
        result === "stale" ? "RevenueCat event older than applied state — status unchanged" : "RevenueCat event mirrored",
      );
      // Referrals move only on production events (sandbox never touches them).
      if (!decision.referrals) return null;
      if (decision.kind === "grant") {
        // Complete a pending referral only when real money moved (price > 0) — a
        // store-side free trial (price 0) must not credit a referrer. Payment is
        // real even if the event arrived late, so a stale grant still counts.
        // Idempotent: completeReferralInTx atomically claims the pending row, so
        // renewals won't re-complete it, and a voided (refunded/lapsed) referral
        // can never complete again.
        if (Number((ev as any).price ?? (ev as any).price_in_purchased_currency ?? 0) > 0) {
          return completeReferralInTx(tx, decision.userId);
        }
      } else if (decision.kind === "refund") {
        // Claw back any reward from the refunded subscription, and void a still-
        // pending referral so a late-delivered purchase event can't complete it.
        await reverseReferralInTx(tx, decision.userId, { refund: true });
      } else if (decision.kind === "expire" && result !== "stale") {
        // Claw back any referral reward earned from this lapsed subscription —
        // unless a newer event (e.g. a renewal) already superseded the expiry.
        await reverseReferralInTx(tx, decision.userId);
      }
      return null;
    });

    // Notify after commit — email must never hold the lock or roll back the event.
    if (award) await notifyReferralAward(award).catch((err) => logger.warn({ err }, "Referral award notification failed"));

    res.status(200).json({ received: true });
    maybePruneEvents(Date.now());
  } catch (err) {
    // Return 5xx so RevenueCat retries rather than silently losing the update.
    // The transaction rolled back, so the event id is not recorded either.
    req.log.error({ err }, "RevenueCat webhook processing failed");
    res.status(500).json({ message: "Webhook processing error" });
  }
});

export default router;
