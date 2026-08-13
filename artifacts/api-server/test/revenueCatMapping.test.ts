import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRevenueCatEvent, resolveUserId, touchesProEntitlement } from "../src/lib/revenueCatMapping.ts";

const NOW = 1_700_000_000_000; // fixed "now" in ms
const FUTURE = NOW + 30 * 86_400_000;
const PAST = NOW - 86_400_000;

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
  assert.equal(mapRevenueCatEvent({ type: "TRANSFER", app_user_id: "5" }, NOW).kind, "ignore");
  assert.equal(mapRevenueCatEvent({ app_user_id: "5" }, NOW).kind, "ignore"); // no type
});
