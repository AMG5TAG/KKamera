import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapRevenueCatEvent as mapWith, mapSubscriberEntitlement, mergeDecision, numericUserIds, resolveUserId, touchesProEntitlement,
  type MirrorRow, type RCEvent,
} from "../src/lib/revenueCatMapping.ts";

const NOW = 1_700_000_000_000; // fixed "now" in ms
const FUTURE = NOW + 30 * 86_400_000;
const PAST = NOW - 86_400_000;
const PROD = { allowSandbox: false };
const mapRevenueCatEvent = (ev: RCEvent, now: number) => mapWith(ev, now, PROD);

test("resolveUserId: picks the first positive integer across app_user_id/original/aliases", () => {
  assert.equal(resolveUserId({ app_user_id: "42" }), 42);
  assert.equal(resolveUserId({ app_user_id: "$RCAnonymousID:abc", aliases: ["7"] }), 7);
  assert.equal(resolveUserId({ original_app_user_id: "99" }), 99);
});

test("resolveUserId: returns null when there is no numeric id (anonymous)", () => {
  assert.equal(resolveUserId({ app_user_id: "$RCAnonymousID:abc" }), null);
  assert.equal(resolveUserId({}), null);
  assert.equal(resolveUserId({ app_user_id: "0" }), null); // not a valid user id
  assert.equal(resolveUserId({ app_user_id: "-3" }), null);
});

test("touchesProEntitlement: matches pro, ignores others, processes unscoped", () => {
  assert.equal(touchesProEntitlement({ entitlement_ids: ["pro"] }), true);
  assert.equal(touchesProEntitlement({ entitlement_id: "pro" }), true);
  assert.equal(touchesProEntitlement({ entitlement_ids: ["other"] }), false);
  assert.equal(touchesProEntitlement({}), true); // unscoped — process it
});

test("grant events with a future expiration → grant", () => {
  for (const type of ["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION", "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED"]) {
    const d = mapRevenueCatEvent({ type, app_user_id: "5", expiration_at_ms: FUTURE, entitlement_ids: ["pro"] }, NOW);
    assert.equal(d.kind, "grant", type);
    if (d.kind === "grant") {
      assert.equal(d.userId, 5);
      assert.equal(d.periodEnd.getTime(), FUTURE);
    }
  }
});

test("grant without an expiration is ignored (never grants perpetual access)", () => {
  const d = mapRevenueCatEvent({ type: "RENEWAL", app_user_id: "5", entitlement_ids: ["pro"] }, NOW);
  assert.equal(d.kind, "ignore");
});

test("CANCELLATION → cancel, keeping access until period end", () => {
  const d = mapRevenueCatEvent({ type: "CANCELLATION", app_user_id: "5", expiration_at_ms: FUTURE }, NOW);
  assert.equal(d.kind, "cancel");
  if (d.kind === "cancel") assert.equal(d.periodEnd?.getTime(), FUTURE);
});

test("BILLING_ISSUE → past_due", () => {
  const d = mapRevenueCatEvent({ type: "BILLING_ISSUE", app_user_id: "5", expiration_at_ms: FUTURE }, NOW);
  assert.equal(d.kind, "past_due");
});

test("EXPIRATION already lapsed → expire; future-dated EXPIRATION is stale → ignore", () => {
  const lapsed = mapRevenueCatEvent({ type: "EXPIRATION", app_user_id: "5", expiration_at_ms: PAST }, NOW);
  assert.equal(lapsed.kind, "expire");

  // A stale EXPIRATION delivered after a renewal must NOT downgrade an active user.
  const future = mapRevenueCatEvent({ type: "EXPIRATION", app_user_id: "5", expiration_at_ms: FUTURE }, NOW);
  assert.equal(future.kind, "ignore");
});

test("anonymous / non-pro / unknown events are ignored", () => {
  assert.equal(mapRevenueCatEvent({ type: "RENEWAL", app_user_id: "$RCAnonymousID:x", expiration_at_ms: FUTURE }, NOW).kind, "ignore");
  assert.equal(mapRevenueCatEvent({ type: "RENEWAL", app_user_id: "5", expiration_at_ms: FUTURE, entitlement_ids: ["other"] }, NOW).kind, "ignore");
  assert.equal(mapRevenueCatEvent({ type: "TRANSFER", app_user_id: "5" }, NOW).kind, "ignore"); // no id lists
  assert.equal(mapRevenueCatEvent({ app_user_id: "5" }, NOW).kind, "ignore"); // no type
});

// --- Sandbox policy -------------------------------------------------------

test("SANDBOX events are ignored when ALLOW_SANDBOX_IAP is off", () => {
  for (const type of ["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION", "TRANSFER"]) {
    const d = mapWith({ type, environment: "SANDBOX", app_user_id: "5", expiration_at_ms: PAST, transferred_to: ["5"] }, NOW, { allowSandbox: false });
    assert.equal(d.kind, "ignore", type);
  }
});

test("SANDBOX events may change access when allowed, but never touch referrals", () => {
  const grant = mapWith({ type: "INITIAL_PURCHASE", environment: "SANDBOX", app_user_id: "5", expiration_at_ms: FUTURE }, NOW, { allowSandbox: true });
  assert.equal(grant.kind, "grant");
  if (grant.kind === "grant") assert.equal(grant.referrals, false);
  const exp = mapWith({ type: "EXPIRATION", environment: "SANDBOX", app_user_id: "5", expiration_at_ms: PAST }, NOW, { allowSandbox: true });
  assert.equal(exp.kind, "expire");
  if (exp.kind === "expire") assert.equal(exp.referrals, false);
});

test("PRODUCTION (or missing environment) events drive referrals", () => {
  for (const environment of ["PRODUCTION", undefined]) {
    const d = mapWith({ type: "RENEWAL", environment, app_user_id: "5", expiration_at_ms: FUTURE }, NOW, { allowSandbox: false });
    assert.equal(d.kind, "grant");
    if (d.kind === "grant") assert.equal(d.referrals, true);
  }
});

// --- Refunds ----------------------------------------------------------------

test("CANCELLATION with cancel_reason CUSTOMER_SUPPORT is a refund pinned to the event expiration", () => {
  const d = mapRevenueCatEvent({ type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", app_user_id: "5", expiration_at_ms: PAST }, NOW);
  assert.equal(d.kind, "refund");
  if (d.kind === "refund") assert.equal(d.periodEnd.getTime(), PAST);
});

test("refund with null/negative expiration ends access now", () => {
  for (const expiration_at_ms of [null, -1000]) {
    const d = mapRevenueCatEvent({ type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", app_user_id: "5", expiration_at_ms }, NOW);
    assert.equal(d.kind, "refund");
    if (d.kind === "refund") assert.equal(d.periodEnd.getTime(), NOW);
  }
});

test("CANCELLATION with other reasons stays a plain cancel", () => {
  const d = mapRevenueCatEvent({ type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE", app_user_id: "5", expiration_at_ms: FUTURE }, NOW);
  assert.equal(d.kind, "cancel");
});

// --- TRANSFER ---------------------------------------------------------------

test("TRANSFER → re-sync numeric ids from both lists (anonymous ids dropped)", () => {
  const d = mapRevenueCatEvent({ type: "TRANSFER", transferred_from: ["$RCAnonymousID:a", "7"], transferred_to: ["9", "9"] }, NOW);
  assert.equal(d.kind, "transfer");
  if (d.kind === "transfer") {
    assert.deepEqual(d.fromUserIds, [7]);
    assert.deepEqual(d.toUserIds, [9]);
  }
  assert.equal(mapRevenueCatEvent({ type: "TRANSFER", transferred_from: ["$RCAnonymousID:a"], transferred_to: ["$RCAnonymousID:b"] }, NOW).kind, "ignore");
  assert.deepEqual(numericUserIds("nope"), []);
});

// --- Row merge ----------------------------------------------------------------

const now = new Date(NOW);
const future = new Date(FUTURE);
const past = new Date(PAST);
const farFuture = new Date(NOW + 400 * 86_400_000); // e.g. a referral free year
function row(p: Partial<MirrorRow>): MirrorRow {
  return { status: "none", trialEnd: null, currentPeriodEnd: null, ...p };
}

test("grant is forward-only and never shortens a referral free year", () => {
  const r = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "grant", userId: 5, periodEnd: future, referrals: true }, now);
  assert.deepEqual(r, { status: "active", currentPeriodEnd: farFuture });
});

test("grant during the server trial never shortens the trial (short store trial)", () => {
  const trialEnd = new Date(NOW + 10 * 86_400_000);
  const storeTrial = new Date(NOW + 3 * 86_400_000);
  const r = mergeDecision(row({ status: "trial", trialEnd }), { kind: "grant", userId: 5, periodEnd: storeTrial, referrals: false }, now);
  assert.deepEqual(r, { status: "active", currentPeriodEnd: trialEnd });
});

test("EXPIRATION keeps a referral free year (period end still in the future)", () => {
  const r = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "expire", userId: 5, referrals: true }, now);
  assert.deepEqual(r, { status: "cancelled", currentPeriodEnd: farFuture });
});

test("EXPIRATION with a lapsed period → expired; running server trial kept; no row → no-op", () => {
  assert.equal(mergeDecision(row({ status: "active", currentPeriodEnd: past }), { kind: "expire", userId: 5, referrals: true }, now)?.status, "expired");
  assert.equal(mergeDecision(row({ status: "trial", trialEnd: future }), { kind: "expire", userId: 5, referrals: true }, now)?.status, "trial");
  assert.equal(mergeDecision(null, { kind: "expire", userId: 5, referrals: true }, now), null);
});

test("refund pins the period end (not forward-only) and expires when past", () => {
  const r = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now);
  assert.deepEqual(r, { status: "expired", currentPeriodEnd: past });
  const f = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "refund", userId: 5, periodEnd: future, referrals: true }, now);
  assert.deepEqual(f, { status: "cancelled", currentPeriodEnd: future });
  // An unused server trial survives a refunded purchase.
  const t = mergeDecision(row({ status: "active", trialEnd: future, currentPeriodEnd: farFuture }), { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now);
  assert.equal(t?.status, "trial");
  assert.equal(mergeDecision(null, { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now), null);
});

test("past_due requires an existing row; cancel keeps the forward-only end", () => {
  assert.equal(mergeDecision(null, { kind: "past_due", userId: 5, periodEnd: future, referrals: true }, now), null);
  assert.deepEqual(
    mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "cancel", userId: 5, periodEnd: future, referrals: true }, now),
    { status: "cancelled", currentPeriodEnd: farFuture },
  );
});

// --- REST subscriber mapping --------------------------------------------------

function subscriber(ent: object | null, sub: object = {}) {
  return {
    subscriber: {
      entitlements: ent ? { pro: { product_identifier: "kk_annual", ...ent } } : {},
      subscriptions: { kk_annual: { store: "app_store", period_type: "normal", is_sandbox: false, ...sub } },
    },
  };
}

test("subscriber sync: active pro entitlement → grant (never referrals)", () => {
  const d = mapSubscriberEntitlement(subscriber({ expires_date: future.toISOString() }), 5, now, PROD);
  assert.equal(d.kind, "entitled");
  if (d.kind === "entitled") {
    assert.equal(d.decision.kind, "grant");
    assert.equal(d.decision.referrals, false);
    assert.equal(d.decision.periodEnd?.getTime(), FUTURE);
    assert.equal(d.store, "app_store");
    assert.equal(d.periodType, "normal");
  }
});

test("subscriber sync: unsubscribed → cancel; billing issue / grace period → past_due", () => {
  const c = mapSubscriberEntitlement(subscriber({ expires_date: future.toISOString() }, { unsubscribe_detected_at: past.toISOString() }), 5, now, PROD);
  assert.equal(c.kind === "entitled" && c.decision.kind, "cancel");
  const b = mapSubscriberEntitlement(subscriber({ expires_date: future.toISOString() }, { billing_issues_detected_at: past.toISOString() }), 5, now, PROD);
  assert.equal(b.kind === "entitled" && b.decision.kind, "past_due");
  const g = mapSubscriberEntitlement(subscriber({ expires_date: past.toISOString(), grace_period_expires_date: future.toISOString() }), 5, now, PROD);
  assert.equal(g.kind === "entitled" && g.decision.kind, "past_due");
});

test("subscriber sync: expired, lifetime, refunded, missing → none", () => {
  assert.equal(mapSubscriberEntitlement(subscriber({ expires_date: past.toISOString() }), 5, now, PROD).kind, "none");
  assert.equal(mapSubscriberEntitlement(subscriber({ expires_date: null }), 5, now, PROD).kind, "none");
  assert.equal(mapSubscriberEntitlement(subscriber({ expires_date: future.toISOString() }, { refunded_at: past.toISOString() }), 5, now, PROD).kind, "none");
  assert.equal(mapSubscriberEntitlement(subscriber(null), 5, now, PROD).kind, "none");
  assert.equal(mapSubscriberEntitlement({}, 5, now, PROD).kind, "none");
});

test("subscriber sync: sandbox entitlement respects ALLOW_SANDBOX_IAP", () => {
  const body = subscriber({ expires_date: future.toISOString() }, { is_sandbox: true });
  assert.equal(mapSubscriberEntitlement(body, 5, now, { allowSandbox: false }).kind, "none");
  const ok = mapSubscriberEntitlement(body, 5, now, { allowSandbox: true });
  assert.equal(ok.kind, "entitled");
  if (ok.kind === "entitled") assert.equal(ok.sandbox, true);
});

test("merge + access: EXPIRATION after a referral award keeps upload access; refund removes it", async () => {
  const { evaluateAccess } = await import("../src/lib/subscriptionAccess.ts");
  const base = row({ status: "active", currentPeriodEnd: farFuture });
  const expired = mergeDecision(base, { kind: "expire", userId: 5, referrals: true }, now)!;
  assert.equal(evaluateAccess({ ...base, ...expired }, now).allow, true);
  const refunded = mergeDecision(base, { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now)!;
  assert.equal(evaluateAccess({ ...base, ...refunded }, now).allow, false);
});
