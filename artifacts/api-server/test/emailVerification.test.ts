import { test } from "node:test";
import assert from "node:assert/strict";

// emailVerification.ts reads SESSION_SECRET lazily (HMAC key).
process.env["SESSION_SECRET"] ??= "test-session-secret-0123456789abcdef-padding";
const {
  generateVerificationCode, formatVerificationCode, normalizeVerificationCode,
  hashVerificationCode, verificationCodeMatches, generateVerificationNonce, hashVerificationNonce,
  isVerificationRedeemable, isSentCodeHash, canSendVerificationCode, canSendAccountExistsNotice,
  VERIFICATION_MAX_ATTEMPTS, VERIFICATION_CODE_TTL_MS, VERIFICATION_SENDS_PER_WINDOW,
  VERIFICATION_MIN_SEND_INTERVAL_MS, VERIFICATION_SEND_WINDOW_MS, UNSENT_CODE_MARKER, NOTICE_CODE_MARKER,
} = await import("../src/lib/emailVerification.ts");

const NOW = new Date("2026-09-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ─── Codes ───────────────────────────────────────────────────────────────────

test("code: always exactly 6 digits (leading zeros kept)", () => {
  for (let i = 0; i < 500; i++) assert.match(generateVerificationCode(), /^\d{6}$/);
});

test("code: displayed as two groups of three", () => {
  assert.equal(formatVerificationCode("482913"), "482 913");
  assert.equal(formatVerificationCode("000123"), "000 123");
});

test("code: normalisation strips spaces/dashes and rejects non-codes", () => {
  assert.equal(normalizeVerificationCode(" 482 913 "), "482913");
  assert.equal(normalizeVerificationCode("482-913"), "482913");
  assert.equal(normalizeVerificationCode("48291"), null);
  assert.equal(normalizeVerificationCode("4829134"), null);
  assert.equal(normalizeVerificationCode("48291a"), null);
  assert.equal(normalizeVerificationCode(""), null);
});

test("code: stored as a keyed HMAC, not the code itself", () => {
  const nh = hashVerificationNonce("nonce-a");
  const stored = hashVerificationCode(nh, "123456");
  assert.match(stored, /^h1:[0-9a-f]{64}$/);
  assert.ok(!stored.includes("123456"));
  assert.equal(stored, hashVerificationCode(nh, "123456")); // deterministic
});

test("code: matches only the right code on the right row", () => {
  const nh = hashVerificationNonce("nonce-a");
  const stored = hashVerificationCode(nh, "123456");
  assert.equal(verificationCodeMatches(stored, nh, "123456"), true);
  assert.equal(verificationCodeMatches(stored, nh, "123 456"), true);
  assert.equal(verificationCodeMatches(stored, nh, "123457"), false);
  assert.equal(verificationCodeMatches(stored, nh, ""), false);
  assert.equal(verificationCodeMatches(stored, nh, "not a code"), false);
  // Bound to the row's nonce: the same code on another row doesn't match.
  assert.equal(verificationCodeMatches(stored, hashVerificationNonce("nonce-b"), "123456"), false);
});

test("code: marker rows never match anything", () => {
  const nh = hashVerificationNonce("n");
  assert.equal(verificationCodeMatches(UNSENT_CODE_MARKER, nh, "123456"), false);
  assert.equal(verificationCodeMatches(NOTICE_CODE_MARKER, nh, "123456"), false);
  assert.equal(isSentCodeHash(UNSENT_CODE_MARKER), false);
  assert.equal(isSentCodeHash(NOTICE_CODE_MARKER), false);
  assert.equal(isSentCodeHash(hashVerificationCode(nh, "000000")), true);
});

// ─── Nonces ──────────────────────────────────────────────────────────────────

test("nonce: 32 random bytes as base64url, unique", () => {
  const a = generateVerificationNonce();
  const b = generateVerificationNonce();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.notEqual(a, b);
});

test("nonce: stored as sha256 hex, deterministic", () => {
  const n = generateVerificationNonce();
  assert.match(hashVerificationNonce(n), /^[0-9a-f]{64}$/);
  assert.equal(hashVerificationNonce(n), hashVerificationNonce(n));
  assert.notEqual(hashVerificationNonce(n), n);
});

// ─── Redeemability ───────────────────────────────────────────────────────────

const liveRow = () => ({
  codeHash: hashVerificationCode("x", "123456"),
  attempts: 0,
  expiresAt: new Date(NOW.getTime() + VERIFICATION_CODE_TTL_MS),
  usedAt: null as Date | null,
});

test("redeemable: fresh row", () => {
  assert.equal(isVerificationRedeemable(liveRow(), NOW), true);
});

test("redeemable: not once used, expired, exhausted or unsent", () => {
  assert.equal(isVerificationRedeemable({ ...liveRow(), usedAt: NOW }, NOW), false);
  assert.equal(isVerificationRedeemable({ ...liveRow(), expiresAt: NOW }, NOW), false);
  assert.equal(isVerificationRedeemable({ ...liveRow(), expiresAt: ago(1) }, NOW), false);
  assert.equal(isVerificationRedeemable({ ...liveRow(), attempts: VERIFICATION_MAX_ATTEMPTS }, NOW), false);
  assert.equal(isVerificationRedeemable({ ...liveRow(), attempts: VERIFICATION_MAX_ATTEMPTS - 1 }, NOW), true);
  assert.equal(isVerificationRedeemable({ ...liveRow(), codeHash: UNSENT_CODE_MARKER }, NOW), false);
  assert.equal(isVerificationRedeemable({ ...liveRow(), codeHash: NOTICE_CODE_MARKER }, NOW), false);
});

test("ttl: codes live 30 minutes, 5 attempts", () => {
  assert.equal(VERIFICATION_CODE_TTL_MS, 30 * 60 * 1000);
  assert.equal(VERIFICATION_MAX_ATTEMPTS, 5);
});

// ─── Throttles ───────────────────────────────────────────────────────────────

test("throttle: first send allowed", () => {
  assert.equal(canSendVerificationCode([], NOW), true);
});

test("throttle: minimum interval between sends", () => {
  assert.equal(canSendVerificationCode([ago(VERIFICATION_MIN_SEND_INTERVAL_MS - 1000)], NOW), false);
  assert.equal(canSendVerificationCode([ago(VERIFICATION_MIN_SEND_INTERVAL_MS)], NOW), true);
});

test("throttle: at most N sends per window", () => {
  const sends = Array.from({ length: VERIFICATION_SENDS_PER_WINDOW }, (_, i) => ago((i + 2) * 5 * 60 * 1000));
  assert.equal(canSendVerificationCode(sends, NOW), false);
  assert.equal(canSendVerificationCode(sends.slice(1), NOW), true);
  // Sends outside the window don't count.
  const old = sends.map(d => new Date(d.getTime() - VERIFICATION_SEND_WINDOW_MS));
  assert.equal(canSendVerificationCode(old, NOW), true);
});

test("throttle: account-exists notice at most once per hour", () => {
  assert.equal(canSendAccountExistsNotice([], NOW), true);
  assert.equal(canSendAccountExistsNotice([ago(30 * 60 * 1000)], NOW), false);
  assert.equal(canSendAccountExistsNotice([ago(VERIFICATION_SEND_WINDOW_MS + 1)], NOW), true);
});
