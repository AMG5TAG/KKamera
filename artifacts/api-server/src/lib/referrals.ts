import { db } from "@workspace/db";
import { subscriptionsTable, referralsTable, usersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger.js";
import { sendEmail, referralRewardEmail } from "./email.js";
import { milestoneAward, milestoneClawback } from "./referralRules.js";

/**
 * Referral milestone logic (1 free year per 5 completed referrals), driven by the
 * RevenueCat webhook now that billing is IAP-only. A referral only completes once
 * the referred user has actually PAID (removing the zero-cost trial-farming
 * vector), and reverses if that subscription later lapses or is refunded.
 * `void` is terminal (see referralRules.nextReferralStatus), so buy → refund →
 * buy again can never award a referrer twice for the same referred user.
 *
 * The *InTx variants run inside the caller's transaction (the RevenueCat webhook
 * applies the mirror write, the referral change and the event-id record
 * atomically, so a failure rolls all of it back and RevenueCat's retry
 * re-applies everything).
 */

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ReferralAward {
  referrerId: number;
  total: number;
  targetYears: number;
}

/**
 * Complete a newly-paid user's pending referral and award referrer milestones.
 * Row-locks the referrer's subscription so it is safe against webhook replays
 * and concurrent completions. Idempotency is anchored on the pending→completed
 * claim and on `freeYearsAwarded`. Returns the award to notify about (send it
 * with notifyReferralAward AFTER the transaction commits), or null.
 */
export async function completeReferralInTx(tx: DbTx, referredUserId: number): Promise<ReferralAward | null> {
  // Atomically claim the pending referral. If another tx already completed it
  // (replay/concurrent), or it was voided by a refund/lapse, nothing is
  // returned and we stop — no double count.
  const [claimed] = await tx
    .update(referralsTable)
    .set({ status: "completed" })
    .where(and(eq(referralsTable.referredId, referredUserId), eq(referralsTable.status, "pending")))
    .returning();
  if (!claimed) return null;

  const referrerId = claimed.referrerId;

  // Guarantee a subscription row exists, then lock it. Doing this as an upsert
  // means the FOR UPDATE lock is always real — even for a referrer who never
  // started a trial — so concurrent completions serialise. The count below is
  // a fresh statement after the lock, so it sees every completion committed by
  // a transaction we waited on.
  await tx.insert(subscriptionsTable)
    .values({ userId: referrerId, status: "none" })
    .onConflictDoNothing();
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

  const award = milestoneAward(total, referrerSub?.freeYearsAwarded ?? 0, referrerSub?.currentPeriodEnd ?? null, new Date());
  if (!award) return null; // milestone already paid

  await tx.update(subscriptionsTable)
    .set({ status: "active", currentPeriodEnd: award.newEnd, freeYearsAwarded: award.targetYears })
    .where(eq(subscriptionsTable.userId, referrerId));

  return { referrerId, total, targetYears: award.targetYears };
}

/** Email the referrer about a milestone (outside the transaction — never hold the lock on email). */
export async function notifyReferralAward(award: ReferralAward): Promise<void> {
  const [referrer] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, award.referrerId))
    .limit(1);
  if (referrer) {
    const template = referralRewardEmail(referrer.name, award.targetYears);
    sendEmail({ to: referrer.email, ...template }).catch(() => {});
  }
  logger.info({ referrerId: award.referrerId, total: award.total }, "Referral milestone reached — free year awarded");
}

/** Standalone wrapper around completeReferralInTx (own transaction + notification). */
export async function completeReferralForUser(referredUserId: number): Promise<void> {
  const award = await db.transaction((tx) => completeReferralInTx(tx, referredUserId));
  if (award) await notifyReferralAward(award);
}

export interface ReverseOptions {
  /**
   * The reversal is a refund: also void a still-pending referral, so a paid
   * event delivered after the refund (out of order) can't complete it.
   */
  refund?: boolean;
}

/**
 * Reverse a referral when the referred user's subscription lapses or is
 * refunded. Marks the referral `void` (terminal), recomputes the referrer's
 * earned milestones under the referrer's row lock, and claws back any free
 * years no longer earned (never below the present, so we never strip
 * already-elapsed access). Idempotent: a replay finds nothing to void.
 */
export async function reverseReferralInTx(tx: DbTx, referredUserId: number, opts: ReverseOptions = {}): Promise<void> {
  const from = opts.refund ? ["completed", "pending"] : ["completed"];
  const [voided] = await tx
    .update(referralsTable)
    .set({ status: "void" })
    .where(and(eq(referralsTable.referredId, referredUserId), inArray(referralsTable.status, from)))
    .returning();
  if (!voided) return; // no live referral — nothing to claw back

  const referrerId = voided.referrerId;
  const [referrerSub] = await tx
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, referrerId))
    .for("update")
    .limit(1);
  if (!referrerSub) return;

  const completed = await tx
    .select({ id: referralsTable.id })
    .from(referralsTable)
    .where(and(eq(referralsTable.referrerId, referrerId), eq(referralsTable.status, "completed")));
  const claw = milestoneClawback(completed.length, referrerSub.freeYearsAwarded ?? 0, referrerSub.currentPeriodEnd, new Date());
  if (!claw) return; // still earns everything granted (or the voided one was only pending)

  await tx.update(subscriptionsTable)
    .set({ currentPeriodEnd: claw.newEnd, freeYearsAwarded: claw.targetYears })
    .where(eq(subscriptionsTable.userId, referrerId));

  logger.warn({ referrerId, referredUserId, yearsRemoved: claw.yearsToRemove }, "Referral reversed — free year clawed back");
}

/** Standalone wrapper around reverseReferralInTx (own transaction). */
export async function reverseReferralForUser(referredUserId: number, opts: ReverseOptions = {}): Promise<void> {
  await db.transaction((tx) => reverseReferralInTx(tx, referredUserId, opts));
}
