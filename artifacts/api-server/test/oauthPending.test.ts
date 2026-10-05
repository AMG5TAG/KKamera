import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_CONNECTION_TTL_MS,
  bindingHashFor,
  generateCallbackCode,
  generateOAuthNonce,
  hashOAuthNonce,
  isPendingExpired,
  isWellFormedCallbackCode,
  isWellFormedNonce,
  isWellFormedNonceHash,
  pendingBindingHash,
  verifyPendingBinding,
} from "../src/lib/oauthPending.ts";

test("nonces and callback codes are random, well-formed base64url", () => {
  const nonces = new Set(Array.from({ length: 50 }, generateOAuthNonce));
  assert.equal(nonces.size, 50);
  for (const n of nonces) assert.ok(isWellFormedNonce(n), n);
  const code = generateCallbackCode();
  assert.ok(isWellFormedCallbackCode(code), code);
  assert.notEqual(generateCallbackCode(), code);
});

test("malformed nonces and codes are rejected", () => {
  for (const bad of [undefined, null, 42, "", "short", "a".repeat(44), "a".repeat(42) + "=", "a".repeat(42) + "/", {}]) {
    assert.equal(isWellFormedNonce(bad), false, JSON.stringify(bad));
  }
  for (const bad of [undefined, "", "a".repeat(21), "a".repeat(23), "a".repeat(21) + "+"]) {
    assert.equal(isWellFormedCallbackCode(bad), false, JSON.stringify(bad));
  }
});

test("the state carries a hash, never the nonce itself", () => {
  const nonce = generateOAuthNonce();
  const h = hashOAuthNonce(nonce);
  assert.notEqual(h, nonce);
  assert.ok(isWellFormedNonceHash(h));
  assert.equal(hashOAuthNonce(nonce), h, "deterministic");
  assert.notEqual(hashOAuthNonce(generateOAuthNonce()), h);
});

test("binding computed at the callback matches the one recomputed at completion", () => {
  const nonce = generateOAuthNonce();
  const code = generateCallbackCode();
  const stored = pendingBindingHash(hashOAuthNonce(nonce), code);
  assert.equal(bindingHashFor(nonce, code), stored);
  assert.equal(verifyPendingBinding(nonce, code, stored), true);
});

test("completion needs BOTH the initiator's nonce and the callback's code", () => {
  const nonce = generateOAuthNonce();
  const code = generateCallbackCode();
  const stored = pendingBindingHash(hashOAuthNonce(nonce), code);
  // Attacker holds the nonce (they initiated) but not the victim's code.
  assert.equal(verifyPendingBinding(nonce, generateCallbackCode(), stored), false);
  // Victim holds the code (their browser got the redirect) but not the nonce.
  assert.equal(verifyPendingBinding(generateOAuthNonce(), code, stored), false);
  // The nonce hash (visible in the state) is not a substitute for the nonce.
  assert.equal(verifyPendingBinding(hashOAuthNonce(nonce), code, stored), false);
  assert.equal(verifyPendingBinding(nonce, code, null), false);
  assert.equal(verifyPendingBinding(nonce, code, ""), false);
  assert.equal(verifyPendingBinding(nonce, code, stored.slice(1)), false);
});

test("pending rows expire after the TTL; a missing expiry counts as expired", () => {
  const now = Date.now();
  assert.equal(PENDING_CONNECTION_TTL_MS, 10 * 60_000);
  assert.equal(isPendingExpired(new Date(now + 1000), now), false);
  assert.equal(isPendingExpired(new Date(now), now), true);
  assert.equal(isPendingExpired(new Date(now - 1), now), true);
  assert.equal(isPendingExpired(null, now), true);
});
