import { test } from "node:test";
import assert from "node:assert/strict";
import {
  earnedFreeYears, milestoneAward, milestoneClawback, nextReferralStatus, type ReferralEvent,
} from "../src/lib/referralRules.ts";

const DAY = 86_400_000;
const now = new Date("2026-06-01T00:00:00Z");
const YEAR_LATER = new Date("2027-06-01T00:00:00Z");

test("status transitions: pending→completed on pay; void is terminal", () => {
  assert.equal(nextReferralStatus("pending", "paid"), "completed");
  assert.equal(nextReferralStatus("completed", "paid"), null, "renewal doesn't re-complete");
  assert.equal(nextReferralStatus("void", "paid"), null, "a voided referral never re-completes");
  assert.equal(nextReferralStatus("completed", "lapsed"), "void");
  assert.equal(nextReferralStatus("pending", "lapsed"), null, "a lapsed price-0 store trial doesn't block a later purchase");
  assert.equal(nextReferralStatus("completed", "refund"), "void");
  assert.equal(nextReferralStatus("pending", "refund"), "void", "refund before the paid event is delivered");
  assert.equal(nextReferralStatus("void", "refund"), null);
});

test("milestone math: award/clawback are idempotent against freeYearsAwarded", () => {
  assert.equal(earnedFreeYears(4), 0);
  assert.equal(earnedFreeYears(5), 1);
  assert.equal(earnedFreeYears(11), 2);
  assert.equal(milestoneAward(4, 0, null, now), null);
  assert.deepEqual(milestoneAward(5, 0, null, now), { targetYears: 1, yearsToAdd: 1, newEnd: YEAR_LATER });
  assert.equal(milestoneAward(5, 1, YEAR_LATER, now), null, "replay after award adds nothing");
  // Extends from a future period end, never from the past.
  const future = new Date(now.getTime() + 30 * DAY);
  assert.equal(milestoneAward(5, 0, future, now)!.newEnd.getFullYear(), future.getFullYear() + 1);
  assert.equal(milestoneAward(5, 0, new Date(now.getTime() - 30 * DAY), now)!.newEnd.getTime(), YEAR_LATER.getTime());
  assert.equal(milestoneClawback(5, 1, YEAR_LATER, now), null);
  assert.deepEqual(milestoneClawback(4, 1, YEAR_LATER, now), { targetYears: 0, yearsToRemove: 1, newEnd: now });
  // Never pulls the end below now.
  assert.equal(milestoneClawback(4, 1, new Date(now.getTime() + 100 * DAY), now)!.newEnd.getTime(), now.getTime());
});

// ---------------------------------------------------------------------------
// Sequence model: mirrors lib/referrals.ts (claim-by-status + recount under the
// referrer lock) and the webhook's event-id dedupe, over an in-memory store.
// ---------------------------------------------------------------------------

function world(referredIds: number[], referrerId = 1) {
  const referrals = new Map(referredIds.map((id) => [id, { referrerId, status: "pending" }]));
  const referrer = { freeYearsAwarded: 0, currentPeriodEnd: null as Date | null };
  const seenEvents = new Set<string>();
  const awards: number[] = [];

  const completedCount = () => [...referrals.values()].filter((r) => r.status === "completed").length;

  function apply(referredId: number, event: ReferralEvent) {
    const ref = referrals.get(referredId);
    if (!ref) return;
    const next = nextReferralStatus(ref.status, event);
    if (!next) return;
    ref.status = next;
    if (event === "paid") {
      const a = milestoneAward(completedCount(), referrer.freeYearsAwarded, referrer.currentPeriodEnd, now);
      if (a) {
        referrer.freeYearsAwarded = a.targetYears;
        referrer.currentPeriodEnd = a.newEnd;
        awards.push(a.targetYears);
      }
    } else {
      const c = milestoneClawback(completedCount(), referrer.freeYearsAwarded, referrer.currentPeriodEnd, now);
      if (c) {
        referrer.freeYearsAwarded = c.targetYears;
        referrer.currentPeriodEnd = c.newEnd;
      }
    }
  }

  /** A webhook delivery: dropped if its id was already processed. */
  function deliver(eventId: string, referredId: number, event: ReferralEvent) {
    if (seenEvents.has(eventId)) return;
    seenEvents.add(eventId);
    apply(referredId, event);
  }

  return { referrals, referrer, awards, deliver };
}

test("complete → refund → repurchase: award, full clawback, no re-award", () => {
  const w = world([11, 12, 13, 14, 15]);
  for (const id of [11, 12, 13, 14, 15]) w.deliver(`buy-${id}`, id, "paid");
  assert.equal(w.referrer.freeYearsAwarded, 1);
  assert.deepEqual(w.awards, [1]);

  w.deliver("refund-15", 15, "refund");
  assert.equal(w.referrals.get(15)!.status, "void");
  assert.equal(w.referrer.freeYearsAwarded, 0, "free year clawed back");
  assert.equal(w.referrer.currentPeriodEnd!.getTime(), now.getTime(), "clawback never below now");

  // Buys again (e.g. a week after the refund): new event id, price > 0.
  w.deliver("rebuy-15", 15, "paid");
  w.deliver("renew-15", 15, "paid");
  assert.equal(w.referrals.get(15)!.status, "void");
  assert.equal(w.referrer.freeYearsAwarded, 0);
  assert.deepEqual(w.awards, [1], "no second award");
});

test("replayed purchase / refund events (same ids) change nothing", () => {
  const w = world([11, 12, 13, 14, 15]);
  for (const id of [11, 12, 13, 14, 15]) w.deliver(`buy-${id}`, id, "paid");
  w.deliver("buy-15", 15, "paid");
  assert.deepEqual(w.awards, [1]);
  w.deliver("refund-15", 15, "refund");
  w.deliver("refund-15", 15, "refund");
  assert.equal(w.referrer.freeYearsAwarded, 0);
  // Even without the id dedupe, a second refund finds nothing to void.
  w.deliver("refund-15-redelivered-without-id", 15, "refund");
  assert.equal(w.referrer.freeYearsAwarded, 0);
});

test("refund delivered BEFORE the purchase event: late purchase can't complete", () => {
  const w = world([11, 12, 13, 14, 15]);
  for (const id of [11, 12, 13, 14]) w.deliver(`buy-${id}`, id, "paid");
  w.deliver("refund-15", 15, "refund");
  w.deliver("buy-15", 15, "paid");
  assert.equal(w.referrals.get(15)!.status, "void");
  assert.equal(w.referrer.freeYearsAwarded, 0);
  assert.deepEqual(w.awards, []);
});

test("after a clawback, a genuinely new 5th referral re-earns the year exactly once", () => {
  const w = world([11, 12, 13, 14, 15, 16]);
  for (const id of [11, 12, 13, 14, 15]) w.deliver(`buy-${id}`, id, "paid");
  w.deliver("refund-15", 15, "refund");
  w.deliver("rebuy-15", 15, "paid");
  w.deliver("buy-16", 16, "paid");
  w.deliver("buy-16", 16, "paid");
  assert.equal(w.referrer.freeYearsAwarded, 1);
  assert.deepEqual(w.awards, [1, 1]);
});

test("lapse claws back but a pending (price-0 trial) referral survives a lapse", () => {
  const w = world([11, 12, 13, 14, 15]);
  w.deliver("exp-11", 11, "lapsed"); // store trial expired before paying
  for (const id of [11, 12, 13, 14, 15]) w.deliver(`buy-${id}`, id, "paid");
  assert.equal(w.referrer.freeYearsAwarded, 1);
  w.deliver("exp-12", 12, "lapsed");
  assert.equal(w.referrer.freeYearsAwarded, 0);
});
