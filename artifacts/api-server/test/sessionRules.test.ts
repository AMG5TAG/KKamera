import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionClaims, isTokenVersionCurrent, SESSION_AUDIENCE,
  loginLockDurationMs, isLoginLocked,
  LOGIN_LOCK_THRESHOLD, LOGIN_LOCK_BASE_MS, LOGIN_LOCK_MAX_MS,
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

test("lockout: 15 min at 5 failures, doubling per further lockout", () => {
  assert.equal(LOGIN_LOCK_BASE_MS, 15 * MIN);
  assert.equal(loginLockDurationMs(5), 15 * MIN);
  assert.equal(loginLockDurationMs(6), 0);
  assert.equal(loginLockDurationMs(9), 0);
  assert.equal(loginLockDurationMs(10), 30 * MIN);
  assert.equal(loginLockDurationMs(15), 60 * MIN);
  assert.equal(loginLockDurationMs(20), 120 * MIN);
});

test("lockout: capped at 24 h, even for huge counts", () => {
  assert.equal(loginLockDurationMs(35), 16 * 60 * MIN); // step 6 → 960 min
  assert.equal(loginLockDurationMs(40), LOGIN_LOCK_MAX_MS); // step 7 → 1920 min → cap
  assert.equal(loginLockDurationMs(5 * 1000), LOGIN_LOCK_MAX_MS);
  assert.equal(loginLockDurationMs(Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % 5)), LOGIN_LOCK_MAX_MS);
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
