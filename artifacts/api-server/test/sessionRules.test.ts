import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionClaims, isTokenVersionCurrent, SESSION_AUDIENCE,
  loginLockDurationMs, isLoginLocked,
  LOGIN_LOCK_THRESHOLD, LOGIN_LOCK_BASE_MS, LOGIN_LOCK_MAX_MS,
  isLoginIpThrottled, loginIpBucket, loginFailureKey, LOGIN_IP_FAILURE_LIMIT, LOGIN_IP_WINDOW_MS,
  isLoginAddressLimited, loginAddressKey, LOGIN_ADDRESS_ATTEMPT_LIMIT,
} from "../src/lib/accountRules.ts";

const MIN = 60_000;

// ─── Session claims ───────────────────────────────────────────────────────────

test("session: legacy token without tv/aud parses with tv 0", () => {
  assert.deepEqual(parseSessionClaims({ userId: 7, iat: 100 }), { userId: 7, tv: 0, iat: 100 });
});

test("session: current token with tv and our aud parses", () => {
  assert.deepEqual(
    parseSessionClaims({ userId: 7, tv: 3, aud: SESSION_AUDIENCE, iat: 1 }),
    { userId: 7, tv: 3, iat: 1 },
  );
  assert.ok(parseSessionClaims({ userId: 7, aud: [SESSION_AUDIENCE, "x"] }));
});

test("session: rejects a foreign aud", () => {
  assert.equal(parseSessionClaims({ userId: 7, aud: "oauth-state" }), null);
  assert.equal(parseSessionClaims({ userId: 7, aud: ["other"] }), null);
});

test("session: rejects non-positive / non-integer / missing userId", () => {
  for (const userId of [0, -1, 1.5, "7", null, undefined, Number.NaN, 2 ** 60]) {
    assert.equal(parseSessionClaims({ userId }), null, String(userId));
  }
  assert.equal(parseSessionClaims(null), null);
  assert.equal(parseSessionClaims("x"), null);
  // OAuth state JWTs carry `sub`, not `userId`.
  assert.equal(parseSessionClaims({ sub: "7" }), null);
});

test("session: rejects malformed tv", () => {
  assert.equal(parseSessionClaims({ userId: 7, tv: -1 }), null);
  assert.equal(parseSessionClaims({ userId: 7, tv: "1" }), null);
  assert.equal(parseSessionClaims({ userId: 7, tv: 1.5 }), null);
});

test("session: version check matches exactly", () => {
  assert.equal(isTokenVersionCurrent({ tv: 0 }, 0), true);
  assert.equal(isTokenVersionCurrent({ tv: 0 }, 1), false);
  assert.equal(isTokenVersionCurrent({ tv: 2 }, 1), false);
});

// ─── Login lockout ────────────────────────────────────────────────────────────

test("lockout: no lock below the threshold", () => {
  for (let n = 0; n < LOGIN_LOCK_THRESHOLD; n++) assert.equal(loginLockDurationMs(n), 0);
});

test("lockout: account-wide ceiling is far above the per-address limit", () => {
  assert.equal(LOGIN_LOCK_THRESHOLD, 50);
  assert.ok(LOGIN_LOCK_THRESHOLD >= 10 * LOGIN_IP_FAILURE_LIMIT);
});

test("lockout: 5 min at the threshold, doubling per further lockout, capped at 15 min", () => {
  const T = LOGIN_LOCK_THRESHOLD;
  assert.equal(LOGIN_LOCK_BASE_MS, 5 * MIN);
  assert.equal(loginLockDurationMs(T), 5 * MIN);
  assert.equal(loginLockDurationMs(T + 1), 0);
  assert.equal(loginLockDurationMs(2 * T - 1), 0);
  assert.equal(loginLockDurationMs(2 * T), 10 * MIN);
  assert.equal(loginLockDurationMs(3 * T), 15 * MIN);
  assert.equal(loginLockDurationMs(4 * T), 15 * MIN);
});

test("lockout: never longer than 15 min, even for huge counts", () => {
  assert.equal(LOGIN_LOCK_MAX_MS, 15 * MIN);
  assert.equal(loginLockDurationMs(LOGIN_LOCK_THRESHOLD * 1000), LOGIN_LOCK_MAX_MS);
  const big = Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % LOGIN_LOCK_THRESHOLD);
  assert.equal(loginLockDurationMs(big), LOGIN_LOCK_MAX_MS);
});

test("lockout: per-address throttle after LOGIN_IP_FAILURE_LIMIT failures in 15 min", () => {
  assert.equal(LOGIN_IP_FAILURE_LIMIT, 5);
  assert.equal(LOGIN_IP_WINDOW_MS, 15 * MIN);
  for (let n = 0; n < LOGIN_IP_FAILURE_LIMIT; n++) assert.equal(isLoginIpThrottled(n), false);
  assert.equal(isLoginIpThrottled(LOGIN_IP_FAILURE_LIMIT), true);
  assert.equal(isLoginIpThrottled(Number.NaN), false);
});

test("lockout: IPv4 (and IPv4-mapped) addresses are bucketed exactly", () => {
  assert.equal(loginIpBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(loginIpBucket("::ffff:203.0.113.7"), "203.0.113.7");
  assert.notEqual(loginIpBucket("203.0.113.7"), loginIpBucket("203.0.113.8"));
});

test("lockout: IPv6 addresses are bucketed by /64", () => {
  assert.equal(loginIpBucket("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(loginIpBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(loginIpBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.notEqual(loginIpBucket("2001:db8:1:2::1"), loginIpBucket("2001:db8:1:3::1"));
});

test("lockout: junk addresses share one bucket", () => {
  assert.equal(loginIpBucket(undefined), "unknown");
  assert.equal(loginIpBucket(""), "unknown");
  assert.equal(loginIpBucket("999.1.1.1"), "unknown");
  assert.equal(loginIpBucket("not-an-ip"), "unknown");
});

test("lockout: failure key separates accounts and addresses", () => {
  assert.equal(loginFailureKey(7, "203.0.113.7"), "login-fail:7:203.0.113.7");
  assert.notEqual(loginFailureKey(7, "203.0.113.7"), loginFailureKey(8, "203.0.113.7"));
  assert.notEqual(loginFailureKey(7, "203.0.113.7"), loginFailureKey(7, "198.51.100.1"));
});

test("lockout: invalid counts never lock", () => {
  assert.equal(loginLockDurationMs(-5), 0);
  assert.equal(loginLockDurationMs(5.5), 0);
  assert.equal(loginLockDurationMs(Number.NaN), 0);
});

test("lockout: isLoginLocked compares against now", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(isLoginLocked(null, now), false);
  assert.equal(isLoginLocked(undefined, now), false);
  assert.equal(isLoginLocked(new Date(now.getTime() - 1), now), false);
  assert.equal(isLoginLocked(now, now), false);
  assert.equal(isLoginLocked(new Date(now.getTime() + 1), now), true);
});

test("session: any typ (e.g. an OAuth state token) is rejected", () => {
  assert.equal(parseSessionClaims({ userId: 7, typ: "oauth-state" }), null);
  assert.equal(parseSessionClaims({ userId: 7, typ: "oauth-state", aud: SESSION_AUDIENCE }), null);
});

test("lockout: per-address attempt limit counts the current attempt and is keyed apart from account failures", () => {
  assert.equal(isLoginAddressLimited(LOGIN_ADDRESS_ATTEMPT_LIMIT), false);
  assert.equal(isLoginAddressLimited(LOGIN_ADDRESS_ATTEMPT_LIMIT + 1), true);
  assert.equal(isLoginAddressLimited(Number.NaN), false);
  assert.equal(loginAddressKey("2001:db8:1:2::1"), loginAddressKey("2001:db8:1:2::ffff"));
  assert.notEqual(loginAddressKey("203.0.113.7"), loginFailureKey(7, "203.0.113.7"));
});
