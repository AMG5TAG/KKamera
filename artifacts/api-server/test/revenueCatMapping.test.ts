import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventIdOf, eventTimeOf, isStaleDecision, mapRevenueCatEvent as mapWith, mapSubscriberEntitlement, mergeDecision, numericUserIds,
  resolveUserId, secretsEqual, touchesProEntitlement, type MirrorDecision, type MirrorRow, type RCEvent,
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
  assert.deepEqual(r, { status: "active", currentPeriodEnd: farFuture, lastEventAt: null });
});

test("grant during the server trial never shortens the trial (short store trial)", () => {
  const trialEnd = new Date(NOW + 10 * 86_400_000);
  const storeTrial = new Date(NOW + 3 * 86_400_000);
  const r = mergeDecision(row({ status: "trial", trialEnd }), { kind: "grant", userId: 5, periodEnd: storeTrial, referrals: false }, now);
  assert.deepEqual(r, { status: "active", currentPeriodEnd: trialEnd, lastEventAt: null });
});

test("EXPIRATION keeps a referral free year (period end still in the future)", () => {
  const r = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "expire", userId: 5, referrals: true }, now);
  assert.deepEqual(r, { status: "cancelled", currentPeriodEnd: farFuture, lastEventAt: null });
});

test("EXPIRATION with a lapsed period → expired; running server trial kept; no row → no-op", () => {
  assert.equal(mergeDecision(row({ status: "active", currentPeriodEnd: past }), { kind: "expire", userId: 5, referrals: true }, now)?.status, "expired");
  assert.equal(mergeDecision(row({ status: "trial", trialEnd: future }), { kind: "expire", userId: 5, referrals: true }, now)?.status, "trial");
  assert.equal(mergeDecision(null, { kind: "expire", userId: 5, referrals: true }, now), null);
});

test("refund pins the period end (not forward-only) and expires when past", () => {
  const r = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now);
  assert.deepEqual(r, { status: "expired", currentPeriodEnd: past, lastEventAt: null });
  const f = mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "refund", userId: 5, periodEnd: future, referrals: true }, now);
  assert.deepEqual(f, { status: "cancelled", currentPeriodEnd: future, lastEventAt: null });
  // An unused server trial survives a refunded purchase.
  const t = mergeDecision(row({ status: "active", trialEnd: future, currentPeriodEnd: farFuture }), { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now);
  assert.equal(t?.status, "trial");
  assert.equal(mergeDecision(null, { kind: "refund", userId: 5, periodEnd: past, referrals: true }, now), null);
});

test("past_due requires an existing row; cancel keeps the forward-only end", () => {
  assert.equal(mergeDecision(null, { kind: "past_due", userId: 5, periodEnd: future, referrals: true }, now), null);
  assert.deepEqual(
    mergeDecision(row({ status: "active", currentPeriodEnd: farFuture }), { kind: "cancel", userId: 5, periodEnd: future, referrals: true }, now),
    { status: "cancelled", currentPeriodEnd: farFuture, lastEventAt: null },
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

// --- Webhook secret ----------------------------------------------------------

test("secretsEqual: matches only the exact secret, any length mismatch is just false", () => {
  assert.equal(secretsEqual("Bearer abc123", "Bearer abc123"), true);
  assert.equal(secretsEqual("Bearer abc124", "Bearer abc123"), false);
  assert.equal(secretsEqual("Bearer abc", "Bearer abc123"), false);
  assert.equal(secretsEqual("", "Bearer abc123"), false);
  assert.equal(secretsEqual("Bearer abc123-and-much-longer", "Bearer abc123"), false);
});

// --- Event id / timestamp --------------------------------------------------------

test("eventIdOf / eventTimeOf parse id and event_timestamp_ms defensively", () => {
  assert.equal(eventIdOf({ id: "evt_1" }), "evt_1");
  for (const id of [undefined, "", 42, "x".repeat(201)]) assert.equal(eventIdOf({ id }), null);
  assert.equal(eventTimeOf({ event_timestamp_ms: NOW })?.getTime(), NOW);
  for (const t of [undefined, null, 0, -5, "nope"]) assert.equal(eventTimeOf({ event_timestamp_ms: t }), null);
  const d = mapRevenueCatEvent({ type: "RENEWAL", app_user_id: "5", expiration_at_ms: FUTURE, event_timestamp_ms: NOW - 1000 }, NOW);
  assert.equal(d.kind === "grant" && d.eventAt?.getTime(), NOW - 1000);
});

// --- Ordering (out-of-order delivery) ---------------------------------------------

const T1 = new Date(NOW - 3 * 3_600_000); // older event
const T2 = new Date(NOW - 3_600_000); // newer event
const farther = new Date(FUTURE + 30 * 86_400_000);
const ev = <K extends MirrorDecision["kind"]>(d: Extract<MirrorDecision, { kind: K }>) => d;

/** Apply a sequence of decisions (in delivery order) to a row, like applyMirrorDecisionInTx. */
function replay(start: MirrorRow | null, ds: MirrorDecision[], opts?: { snapshot?: boolean }[]): MirrorRow | null {
  let r = start;
  ds.forEach((d, i) => {
    const next = mergeDecision(r, d, now, opts?.[i]);
    if (next) r = { trialEnd: r?.trialEnd ?? null, ...next };
  });
  return r;
}

test("non-stale writes advance lastEventAt; it never goes backwards or beyond now", () => {
  const r = mergeDecision(row({ status: "active", currentPeriodEnd: future }), ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T2 }), now);
  assert.equal(r?.lastEventAt?.getTime(), T2.getTime());
  const skewed = mergeDecision(null, ev<"grant">({ kind: "grant", userId: 5, periodEnd: future, referrals: true, eventAt: new Date(NOW + 86_400_000) }), now);
  assert.equal(skewed?.lastEventAt?.getTime(), NOW, "future event time clamped to now");
  const noTs = mergeDecision(row({ status: "active", currentPeriodEnd: future, lastEventAt: T1 }), ev<"cancel">({ kind: "cancel", userId: 5, periodEnd: future, referrals: true }), now);
  assert.equal(noTs?.status, "cancelled", "event without timestamp applies as before");
  assert.equal(noTs?.lastEventAt?.getTime(), T1.getTime());
});

test("RENEWAL then an OLDER CANCELLATION: stays active", () => {
  const r = replay(row({ status: "active", currentPeriodEnd: future }), [
    ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T2 }),
    ev<"cancel">({ kind: "cancel", userId: 5, periodEnd: future, referrals: true, eventAt: T1 }),
  ]);
  assert.equal(r?.status, "active");
  assert.equal(r?.currentPeriodEnd?.getTime(), farther.getTime());
  assert.equal(r?.lastEventAt?.getTime(), T2.getTime());
});

test("RENEWAL then an OLDER BILLING_ISSUE: not marked past_due", () => {
  const base = row({ status: "active", currentPeriodEnd: future });
  const r = replay(base, [
    ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T2 }),
    ev<"past_due">({ kind: "past_due", userId: 5, periodEnd: future, referrals: true, eventAt: T1 }),
  ]);
  assert.equal(r?.status, "active");
  assert.equal(isStaleDecision(r, ev<"past_due">({ kind: "past_due", userId: 5, periodEnd: future, referrals: true, eventAt: T1 }), now), true);
});

test("UNCANCELLATION then an OLDER EXPIRATION: not expired, and reported stale", () => {
  const r = replay(row({ status: "cancelled", currentPeriodEnd: past }), [
    ev<"grant">({ kind: "grant", userId: 5, periodEnd: future, referrals: true, eventAt: T2 }),
  ]);
  assert.equal(r?.status, "active");
  const exp = ev<"expire">({ kind: "expire", userId: 5, referrals: true, eventAt: T1 });
  assert.equal(isStaleDecision(r, exp, now), true);
  assert.equal(mergeDecision(r, exp, now), null);
  // Same EXPIRATION in order (newer) still expires as before.
  const newer = mergeDecision(row({ status: "active", currentPeriodEnd: past, lastEventAt: T1 }), ev<"expire">({ kind: "expire", userId: 5, referrals: true, eventAt: T2 }), now);
  assert.equal(newer?.status, "expired");
});

test("an OLDER grant can't resurrect a newer cancel/expiry, but may extend a live paid period", () => {
  const cancelled = row({ status: "cancelled", currentPeriodEnd: future, lastEventAt: T2 });
  assert.equal(mergeDecision(cancelled, ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T1 }), now), null);
  const expired = row({ status: "expired", currentPeriodEnd: past, lastEventAt: T2 });
  assert.equal(mergeDecision(expired, ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T1 }), now), null);
  // Live row: forward-only period extension, status and lastEventAt untouched.
  const pastDue = row({ status: "past_due", currentPeriodEnd: future, lastEventAt: T2 });
  assert.deepEqual(
    mergeDecision(pastDue, ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T1 }), now),
    { status: "past_due", currentPeriodEnd: farther, lastEventAt: T2 },
  );
  // ...and never shortens it.
  const active = row({ status: "active", currentPeriodEnd: farther, lastEventAt: T2 });
  assert.equal(mergeDecision(active, ev<"cancel">({ kind: "cancel", userId: 5, periodEnd: future, referrals: true, eventAt: T1 }), now), null);
});

test("refunds are never stale; after a refund an older grant can't restore access", () => {
  const active = row({ status: "active", currentPeriodEnd: farther, lastEventAt: T2 });
  const refunded = mergeDecision(active, ev<"refund">({ kind: "refund", userId: 5, periodEnd: past, referrals: true, eventAt: T1 }), now);
  assert.equal(refunded?.status, "expired");
  assert.equal(refunded?.lastEventAt?.getTime(), T2.getTime(), "lastEventAt never moves backwards");
  // Refund with a future pinned end (cancelled) + older RENEWAL delivered late.
  const pinned = row({ status: "cancelled", currentPeriodEnd: future, lastEventAt: T2 });
  assert.equal(mergeDecision(pinned, ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T1 }), now), null);
});

test("duplicate delivery (same event twice) converges to the same row", () => {
  const renewal = ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: true, eventAt: T2 });
  const once = replay(row({ status: "active", currentPeriodEnd: future }), [renewal]);
  const twice = replay(row({ status: "active", currentPeriodEnd: future }), [renewal, renewal]);
  assert.deepEqual(twice, once);
  // Equal timestamps are not stale (a second distinct event at the same ms applies).
  assert.equal(isStaleDecision(once, renewal, now), false);
  const cancelSameMs = mergeDecision(once, ev<"cancel">({ kind: "cancel", userId: 5, periodEnd: farther, referrals: true, eventAt: T2 }), now);
  assert.equal(cancelSameMs?.status, "cancelled");
});

test("REST snapshot (sync) is never blocked by lastEventAt and stamps it with now", () => {
  const cancelledLater = row({ status: "cancelled", currentPeriodEnd: past, lastEventAt: T2 });
  const snap = mergeDecision(cancelledLater, ev<"grant">({ kind: "grant", userId: 5, periodEnd: farther, referrals: false }), now, { snapshot: true });
  assert.equal(snap?.status, "active");
  assert.equal(snap?.lastEventAt?.getTime(), NOW);
  // A webhook generated before the snapshot and delivered after it is stale.
  const r = { ...cancelledLater, ...snap! };
  assert.equal(mergeDecision(r, ev<"cancel">({ kind: "cancel", userId: 5, periodEnd: future, referrals: true, eventAt: T2 }), now), null);
});
