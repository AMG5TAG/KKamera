// Pure referral state/milestone rules — no DB imports, so they're unit-testable
// in isolation (see test/referralRules.test.ts). lib/referrals.ts applies them
// under row locks inside the RevenueCat webhook transaction.

export const REFERRALS_PER_FREE_YEAR = 5;

/**
 * What happened to the referred user's store subscription:
 * - `paid`: a production grant with price > 0 (completes a pending referral)
 * - `lapsed`: EXPIRATION (claws back a completed referral)
 * - `refund`: refund (voids the referral whether completed or still pending)
 */
export type ReferralEvent = "paid" | "lapsed" | "refund";

/**
 * Next referral status for an event, or null for "no transition". `void` is
 * terminal: once a referral is reversed (lapse or refund) no later purchase can
 * re-complete it, so buy → refund → buy again can never award the referrer
 * twice. A refund also voids a still-`pending` referral, so a refund delivered
 * before (or instead of) the paid event can't be followed by a late completion.
 * A lapse leaves `pending` alone (a price-0 store trial that expired must not
 * block a later genuine purchase).
 */
export function nextReferralStatus(status: string, event: ReferralEvent): string | null {
  switch (event) {
    case "paid":
      return status === "pending" ? "completed" : null;
    case "lapsed":
      return status === "completed" ? "void" : null;
    case "refund":
      return status === "completed" || status === "pending" ? "void" : null;
  }
}

/** Free years a referrer has earned for `completedCount` completed referrals. */
export function earnedFreeYears(completedCount: number): number {
  return Math.floor(completedCount / REFERRALS_PER_FREE_YEAR);
}

function addYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setFullYear(out.getFullYear() + years);
  return out;
}

/**
 * Milestone award after a completion. Idempotency is anchored on
 * `freeYearsAwarded` (read under the referrer's row lock): only years earned
 * beyond what was already granted are added, extending from the later of the
 * current period end or now. Null = nothing to award.
 */
export function milestoneAward(
  completedCount: number,
  freeYearsAwarded: number,
  currentPeriodEnd: Date | null,
  now: Date,
): { targetYears: number; yearsToAdd: number; newEnd: Date } | null {
  const targetYears = earnedFreeYears(completedCount);
  if (targetYears <= freeYearsAwarded) return null;
  const yearsToAdd = targetYears - freeYearsAwarded;
  const base = currentPeriodEnd && currentPeriodEnd > now ? currentPeriodEnd : now;
  return { targetYears, yearsToAdd, newEnd: addYears(base, yearsToAdd) };
}

/**
 * Milestone clawback after a reversal: removes years no longer earned, never
 * pulling the period end below `now` (already-elapsed access isn't taken back).
 * Null = the referrer still earns everything granted.
 */
export function milestoneClawback(
  completedCount: number,
  freeYearsAwarded: number,
  currentPeriodEnd: Date | null,
  now: Date,
): { targetYears: number; yearsToRemove: number; newEnd: Date } | null {
  const targetYears = earnedFreeYears(completedCount);
  if (targetYears >= freeYearsAwarded) return null;
  const yearsToRemove = freeYearsAwarded - targetYears;
  let newEnd = addYears(currentPeriodEnd ?? now, -yearsToRemove);
  if (newEnd < now) newEnd = now;
  return { targetYears, yearsToRemove, newEnd };
}
