import { getStripeSync, getUncachableStripeClient } from "./stripeClient.js";
import { db } from "@workspace/db";
import { subscriptionsTable, referralsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./lib/logger.js";
import { sendPushToUser } from "./lib/pushNotifications.js";
import {
  sendEmail, referralRewardEmail, subscriptionActiveEmail, subscriptionCancelledEmail,
} from "./lib/email.js";

/**
 * Build a `.set()` fragment that advances currentPeriodEnd but never moves it
 * backwards — Stripe does not guarantee event ordering, so a late/stale event
 * must not rewind an already-applied newer period end. GREATEST skips NULLs.
 */
function forwardPeriodEnd(periodEnd: Date | null): { currentPeriodEnd: any } | {} {
  return periodEnd
    ? { currentPeriodEnd: sql`GREATEST(${subscriptionsTable.currentPeriodEnd}, ${periodEnd})` }
    : {};
}

/** Best-effort lifecycle email to the user behind a subscription. */
async function emailUser(
  userId: number,
  build: (name: string) => { subject: string; html: string },
): Promise<void> {
  const [u] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (u) sendEmail({ to: u.email, ...build(u.name) }).catch(() => {});
}

/**
 * Extract the current period end from a Stripe Subscription object.
 * In API version 2025-08-27.basil, `current_period_end` was removed from the
 * Subscription object and now lives on each subscription *item*. We read the
 * item value first and fall back to the legacy top-level field for safety.
 * Returns null if no valid timestamp is present (never an Invalid Date).
 */
function periodEndFromSubscription(sub: any): Date | null {
  // Take the furthest period end across all items (a multi-item/add-on
  // subscription would otherwise pick an arbitrary line), falling back to the
  // legacy top-level field.
  const itemEnds: number[] = Array.isArray(sub?.items?.data)
    ? sub.items.data
        .map((i: any) => i?.current_period_end)
        .filter((n: unknown): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
  const epochSeconds =
    itemEnds.length > 0
      ? Math.max(...itemEnds)
      : typeof sub?.current_period_end === "number" && Number.isFinite(sub.current_period_end)
        ? sub.current_period_end
        : null;
  return epochSeconds == null ? null : new Date(epochSeconds * 1000);
}

/** Look up userId from a Stripe customerId */
async function getUserIdForCustomer(customerId: string): Promise<number | null> {
  const [sub] = await db
    .select({ userId: subscriptionsTable.userId })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.stripeCustomerId, customerId))
    .limit(1);
  return sub?.userId ?? null;
}

/**
 * Complete a newly-paid user's pending referral and award referrer milestones
 * (1 free year per 5 completed referrals).
 *
 * Runs in a single transaction with a row lock on the referrer's subscription so
 * it is safe against (a) Stripe webhook replays/redeliveries and (b) concurrent
 * referral completions. Idempotency is anchored on `freeYearsAwarded`: we only
 * grant years for milestones not already recorded, so re-processing the same
 * event never double-awards.
 */
async function completeReferralForUser(referredUserId: number): Promise<void> {
  const result = await db.transaction(async (tx) => {
    // Atomically claim the pending referral. If another tx already completed it
    // (replay/concurrent), nothing is returned and we stop — no double count.
    const [claimed] = await tx
      .update(referralsTable)
      .set({ status: "completed" })
      .where(and(eq(referralsTable.referredId, referredUserId), eq(referralsTable.status, "pending")))
      .returning();
    if (!claimed) return null;

    const referrerId = claimed.referrerId;

    // Lock the referrer's subscription row to serialise concurrent milestone math.
    const [referrerSub] = await tx
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, referrerId))
      .for("update")
      .limit(1);

    const completed = await tx
      .select({ id: referralsTable.id })
      .from(referralsTable)
      .where(and(eq(referralsTable.referrerId, referrerId), eq(referralsTable.status, "completed")));
    const total = completed.length;

    const targetYears = Math.floor(total / 5);
    const alreadyAwarded = referrerSub?.freeYearsAwarded ?? 0;
    if (targetYears <= alreadyAwarded) return null; // milestone already paid

    const yearsToAdd = targetYears - alreadyAwarded;
    const base =
      referrerSub?.currentPeriodEnd && referrerSub.currentPeriodEnd > new Date()
        ? referrerSub.currentPeriodEnd
        : new Date();
    const newEnd = new Date(base);
    newEnd.setFullYear(newEnd.getFullYear() + yearsToAdd);

    if (referrerSub) {
      await tx.update(subscriptionsTable)
        .set({ status: "active", currentPeriodEnd: newEnd, freeYearsAwarded: targetYears })
        .where(eq(subscriptionsTable.userId, referrerId));
    } else {
      await tx.insert(subscriptionsTable).values({
        userId: referrerId, status: "active", currentPeriodEnd: newEnd, freeYearsAwarded: targetYears,
      });
    }

    return { referrerId, total, targetYears };
  });

  if (!result) return;

  // Notify the referrer (outside the transaction — email must not hold the lock).
  const [referrer] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, result.referrerId))
    .limit(1);
  if (referrer) {
    const template = referralRewardEmail(referrer.name, result.targetYears);
    sendEmail({ to: referrer.email, ...template }).catch(() => {});
  }
  logger.info({ referrerId: result.referrerId, total: result.total }, "Referral milestone reached — free year awarded");
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
        "Ensure the webhook route is registered BEFORE app.use(express.json())."
      );
    }
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // Parse the event (already verified above) and mirror into our subscriptionsTable
    try {
      const event = JSON.parse(payload.toString("utf8")) as { type: string; data: { object: any } };
      await WebhookHandlers.handleSubscriptionEvent(event);
    } catch (err) {
      logger.error({ err }, "Subscription DB mirror failed after Stripe webhook");
    }
  }

  static async handleSubscriptionEvent(event: { type: string; data: { object: any } }): Promise<void> {
    const obj = event.data.object;

    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode !== "subscription" || !obj.customer || !obj.subscription) break;
        try {
          const stripe = await getUncachableStripeClient();
          const stripeSub = await stripe.subscriptions.retrieve(obj.subscription as string) as any;
          const periodEnd = periodEndFromSubscription(stripeSub);
          const setFields = {
            stripeSubscriptionId: obj.subscription as string,
            status: "active",
            ...forwardPeriodEnd(periodEnd),
          };
          const updated = await db.update(subscriptionsTable)
            .set(setFields)
            .where(eq(subscriptionsTable.stripeCustomerId, obj.customer as string))
            .returning({ userId: subscriptionsTable.userId });

          let userId = updated[0]?.userId ?? null;
          if (updated.length === 0) {
            // The row may not carry stripeCustomerId yet — fall back to the userId
            // we stamped into the checkout session metadata.
            const metaUserId = Number(obj.metadata?.userId);
            if (Number.isFinite(metaUserId) && metaUserId > 0) {
              await db.update(subscriptionsTable)
                .set({ ...setFields, stripeCustomerId: obj.customer as string })
                .where(eq(subscriptionsTable.userId, metaUserId));
              userId = metaUserId;
              logger.warn({ customerId: obj.customer, userId }, "Checkout matched 0 rows by customer; used metadata.userId");
            } else {
              logger.warn({ customerId: obj.customer }, "Checkout matched 0 rows and no metadata.userId");
            }
          }
          logger.info({ customerId: obj.customer }, "Subscription activated via checkout");

          if (userId) {
            await emailUser(userId, subscriptionActiveEmail);
            await completeReferralForUser(userId);
          }
        } catch (err) {
          logger.error({ err }, "Failed to activate subscription after checkout");
        }
        break;
      }

      case "customer.subscription.updated": {
        const customerId = obj.customer as string;
        const periodEnd = periodEndFromSubscription(obj);
        const stripeStatus: string = obj.status;
        // Map to our status. `null` means "don't touch status" — used for
        // transient/unknown Stripe states (e.g. `incomplete` right after
        // checkout) so an out-of-order event can't downgrade an active user.
        const status: string | null =
          stripeStatus === "active" ? "active"
          : stripeStatus === "trialing" ? "trial"
          : stripeStatus === "past_due" ? "past_due"
          : stripeStatus === "unpaid" ? "past_due"
          : stripeStatus === "canceled" ? "expired"
          : stripeStatus === "incomplete_expired" ? "expired"
          : null;
        await db.update(subscriptionsTable)
          .set({
            ...(status ? { status } : {}),
            ...forwardPeriodEnd(periodEnd),
            stripeSubscriptionId: obj.id as string,
          })
          .where(eq(subscriptionsTable.stripeCustomerId, customerId));
        logger.info({ customerId, stripeStatus, status }, "Subscription updated");
        break;
      }

      case "customer.subscription.deleted": {
        const customerId = obj.customer as string;
        const updated = await db.update(subscriptionsTable)
          .set({ status: "expired" })
          .where(eq(subscriptionsTable.stripeCustomerId, customerId))
          .returning({ userId: subscriptionsTable.userId, currentPeriodEnd: subscriptionsTable.currentPeriodEnd });
        logger.info({ customerId }, "Subscription expired");
        const row = updated[0];
        if (row?.userId) {
          const accessUntil = (row.currentPeriodEnd ?? new Date()).toLocaleDateString();
          await emailUser(row.userId, (name) => subscriptionCancelledEmail(name, accessUntil));
          await sendPushToUser(row.userId, { type: "trial_expired" }).catch(() => {});
        }
        break;
      }

      case "customer.subscription.trial_will_end": {
        // Sent 3 days before trial ends
        const customerId = obj.customer as string;
        const trialEnd = obj.trial_end as number;
        const daysLeft = Math.ceil((trialEnd * 1000 - Date.now()) / 86_400_000);
        const userId = await getUserIdForCustomer(customerId);
        if (userId) {
          await sendPushToUser(userId, { type: "trial_ending", daysLeft }).catch(() => {});
        }
        logger.info({ customerId, daysLeft }, "Trial ending push sent");
        break;
      }

      case "invoice.payment_failed": {
        const customerId = obj.customer as string;
        await db.update(subscriptionsTable)
          .set({ status: "past_due" })
          .where(eq(subscriptionsTable.stripeCustomerId, customerId));
        logger.info({ customerId }, "Subscription payment failed");
        const userId = await getUserIdForCustomer(customerId);
        if (userId) {
          await sendPushToUser(userId, { type: "payment_failed" }).catch(() => {});
        }
        break;
      }

      case "invoice.payment_succeeded": {
        if (obj.billing_reason === "subscription_cycle") {
          const customerId = obj.customer as string;
          const periodEnd = obj.lines?.data?.[0]?.period?.end
            ? new Date(obj.lines.data[0].period.end * 1000)
            : null;
          await db.update(subscriptionsTable)
            .set({ status: "active", ...forwardPeriodEnd(periodEnd) })
            .where(eq(subscriptionsTable.stripeCustomerId, customerId));
          logger.info({ customerId }, "Subscription renewed");
          const userId = await getUserIdForCustomer(customerId);
          if (userId && periodEnd) {
            await sendPushToUser(userId, {
              type: "subscription_renewed",
              renewalDate: periodEnd.toLocaleDateString(),
            }).catch(() => {});
          }
        }
        break;
      }

      default:
        break;
    }
  }
}
