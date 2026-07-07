import { db } from "@workspace/db";
import { subscriptionsTable, referralsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { sendEmail, referralRewardEmail } from "./email.js";

/**
 * Referral milestone logic (1 free year per 5 completed referrals), driven by the
 * RevenueCat webhook now that billing is IAP-only. A referral only completes once
 * the referred user has actually PAID (removing the zero-cost trial-farming
 * vector), and reverses if that subscription is later cancelled/refunded.
 */

/**
 * Complete a newly-paid user's pending referral and award referrer milestones.
 * Runs in a single transaction with a row lock on the referrer's subscription so
 * it is safe against webhook replays and concurrent completions. Idempotency is
 * anchored on `freeYearsAwarded`.
 */
export async function completeReferralForUser(referredUserId: number): Promise<void> {
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

    // Guarantee a subscription row exists, then lock it. Doing this as an upsert
    // means the FOR UPDATE lock is always real — even for a referrer who never
    // started a trial — so concurrent completions serialise.
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

    await tx.update(subscriptionsTable)
      .set({ status: "active", currentPeriodEnd: newEnd, freeYearsAwarded: targetYears })
      .where(eq(subscriptionsTable.userId, referrerId));

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

/**
 * Reverse a previously-completed referral when the referred user's subscription
 * is cancelled/refunded. Marks the referral `void`, recomputes the referrer's
 * earned milestones, and claws back any free years no longer earned (never below
 * the present, so we never strip already-elapsed access). Idempotent.
 */
export async function reverseReferralForUser(referredUserId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [voided] = await tx
      .update(referralsTable)
      .set({ status: "void" })
      .where(and(eq(referralsTable.referredId, referredUserId), eq(referralsTable.status, "completed")))
      .returning();
    if (!voided) return; // wasn't a completed referral — nothing to claw back

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
    const targetYears = Math.floor(completed.length / 5);
    const alreadyAwarded = referrerSub.freeYearsAwarded ?? 0;
    if (targetYears >= alreadyAwarded) return; // still earns everything granted

    const yearsToRemove = alreadyAwarded - targetYears;
    const now = new Date();
    let newEnd = referrerSub.currentPeriodEnd ?? now;
    newEnd = new Date(newEnd);
    newEnd.setFullYear(newEnd.getFullYear() - yearsToRemove);
    if (newEnd < now) newEnd = now;

    await tx.update(subscriptionsTable)
      .set({ currentPeriodEnd: newEnd, freeYearsAwarded: targetYears })
      .where(eq(subscriptionsTable.userId, referrerId));

    logger.warn({ referrerId, referredUserId, yearsRemoved: yearsToRemove }, "Referral reversed — free year clawed back");
  });
}
