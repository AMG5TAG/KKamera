import { test } from "node:test";
import assert from "node:assert/strict";
import { periodEndFromSubscription, mapStripeStatus } from "../src/lib/stripeMapping.ts";

test("periodEnd: takes the furthest end across items", () => {
  const sub = { items: { data: [{ current_period_end: 1000 }, { current_period_end: 5000 }, { current_period_end: 3000 }] } };
  assert.equal(periodEndFromSubscription(sub)?.getTime(), 5000 * 1000);
});

test("periodEnd: falls back to the legacy top-level field", () => {
  assert.equal(periodEndFromSubscription({ current_period_end: 2000 })?.getTime(), 2000 * 1000);
});

test("periodEnd: item values take precedence over the legacy field", () => {
  const sub = { current_period_end: 1, items: { data: [{ current_period_end: 9000 }] } };
  assert.equal(periodEndFromSubscription(sub)?.getTime(), 9000 * 1000);
});

test("periodEnd: returns null for missing/invalid (never an Invalid Date)", () => {
  for (const s of [{}, null, undefined, { items: { data: [] } }, { current_period_end: "nope" }, { items: { data: [{ current_period_end: NaN }] } }]) {
    assert.equal(periodEndFromSubscription(s), null);
  }
});

test("mapStripeStatus: known transitions", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trial");
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("unpaid"), "past_due");
  assert.equal(mapStripeStatus("canceled"), "expired");
  assert.equal(mapStripeStatus("incomplete_expired"), "expired");
});

test("mapStripeStatus: transient/unknown states return null (won't downgrade an active user)", () => {
  for (const s of ["incomplete", "paused", "weird", ""]) {
    assert.equal(mapStripeStatus(s), null, s);
  }
});
