import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAccess, type AccessInput } from "../src/lib/subscriptionAccess.ts";
import { SUBSCRIPTION_STATUS } from "../src/lib/constants.ts";

test("inlined statuses still match the canonical constants (drift guard)", () => {
  assert.equal(SUBSCRIPTION_STATUS.TRIAL, "trial");
  assert.equal(SUBSCRIPTION_STATUS.ACTIVE, "active");
  assert.equal(SUBSCRIPTION_STATUS.CANCELLED, "cancelled");
  assert.equal(SUBSCRIPTION_STATUS.PAST_DUE, "past_due");
});

const DAY = 86_400_000;
const now = new Date("2026-06-01T00:00:00Z");
const future = new Date(now.getTime() + 30 * DAY);
const past = new Date(now.getTime() - 30 * DAY);

function sub(p: Partial<AccessInput>): AccessInput {
  return { status: "none", trialEnd: null, currentPeriodEnd: null, ...p };
}

test("no subscription denies", () => {
  assert.equal(evaluateAccess(null, now).allow, false);
  assert.equal(evaluateAccess(undefined, now).allow, false);
});

test("trial: valid future end allows; past or null end denies", () => {
  assert.equal(evaluateAccess(sub({ status: "trial", trialEnd: future }), now).allow, true);
  assert.equal(evaluateAccess(sub({ status: "trial", trialEnd: past }), now).allow, false);
  assert.equal(evaluateAccess(sub({ status: "trial", trialEnd: null }), now).allow, false);
});

test("active: future period allows; past or null period denies (no perpetual access)", () => {
  assert.equal(evaluateAccess(sub({ status: "active", currentPeriodEnd: future }), now).allow, true);
  assert.equal(evaluateAccess(sub({ status: "active", currentPeriodEnd: past }), now).allow, false);
  assert.equal(evaluateAccess(sub({ status: "active", currentPeriodEnd: null }), now).allow, false);
});

test("cancelled: access until the already-paid period/trial elapses", () => {
  assert.equal(evaluateAccess(sub({ status: "cancelled", currentPeriodEnd: future }), now).allow, true);
  assert.equal(evaluateAccess(sub({ status: "cancelled", trialEnd: future }), now).allow, true);
  assert.equal(evaluateAccess(sub({ status: "cancelled", currentPeriodEnd: past }), now).allow, false);
  assert.equal(evaluateAccess(sub({ status: "cancelled" }), now).allow, false);
});

test("past_due: allowed within grace of period end, denied after, denied when null", () => {
  const grace = 14 * DAY;
  assert.equal(evaluateAccess(sub({ status: "past_due", currentPeriodEnd: future }), now, grace).allow, true, "still in paid period");
  assert.equal(evaluateAccess(sub({ status: "past_due", currentPeriodEnd: new Date(now.getTime() - 5 * DAY) }), now, grace).allow, true, "within 14d grace");
  assert.equal(evaluateAccess(sub({ status: "past_due", currentPeriodEnd: new Date(now.getTime() - 20 * DAY) }), now, grace).allow, false, "past grace");
  assert.equal(evaluateAccess(sub({ status: "past_due", currentPeriodEnd: null }), now, grace).allow, false, "no anchor");
});

test("none / expired / unknown statuses deny", () => {
  for (const s of ["none", "expired", "weird"]) {
    assert.equal(evaluateAccess(sub({ status: s }), now).allow, false, s);
  }
});
