import { test } from "node:test";
import assert from "node:assert/strict";
import { CA_VALID_PIN, TlsPinGuard, normalizeFingerprint, pinDecision } from "../src/lib/tlsPin.ts";

const FP_A = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase()).join(":");
const FP_B = Array.from({ length: 32 }, (_, i) => (255 - i).toString(16).padStart(2, "0").toUpperCase()).join(":");

test("normalizeFingerprint: accepts colon/case variants of a SHA-256 only", () => {
  assert.equal(normalizeFingerprint(FP_A), FP_A.replace(/:/g, ""));
  assert.equal(normalizeFingerprint(FP_A.toLowerCase()), FP_A.replace(/:/g, ""));
  assert.equal(normalizeFingerprint("AB:CD"), null);
  assert.equal(normalizeFingerprint(null), null);
});

test("pinDecision: a CA-valid certificate is always fine, and is recorded", () => {
  assert.equal(pinDecision({ authorized: true, sessionReused: false, fingerprint: FP_B, pin: FP_A }), "ca_valid");
  assert.equal(pinDecision({ authorized: true, sessionReused: false, fingerprint: FP_B, pin: null }), "ca_valid");
  // Already recorded (e.g. a Let's Encrypt renewal): nothing to persist.
  assert.equal(pinDecision({ authorized: true, sessionReused: false, fingerprint: FP_B, pin: CA_VALID_PIN }), "ok");
});

test("pinDecision: once a CA-valid certificate was seen, a self-signed one is never a first use", () => {
  assert.equal(pinDecision({ authorized: false, sessionReused: false, fingerprint: FP_A, pin: CA_VALID_PIN }), "mismatch");
});

test("pinDecision: first unpinned certificate is trusted on first use", () => {
  assert.equal(pinDecision({ authorized: false, sessionReused: false, fingerprint: FP_A, pin: null }), "first_use");
});

test("pinDecision: matching pin ok, different certificate refused", () => {
  assert.equal(pinDecision({ authorized: false, sessionReused: false, fingerprint: FP_A, pin: FP_A.toLowerCase() }), "ok");
  assert.equal(pinDecision({ authorized: false, sessionReused: false, fingerprint: FP_B, pin: FP_A }), "mismatch");
});

test("pinDecision: no certificate → refused; resumed session → ok", () => {
  assert.equal(pinDecision({ authorized: false, sessionReused: false, fingerprint: null, pin: null }), "mismatch");
  assert.equal(pinDecision({ authorized: false, sessionReused: true, fingerprint: null, pin: FP_A }), "ok");
});

function fakeSocket(fp: string | null, authorized = false, reused = false) {
  return {
    authorized,
    isSessionReused: () => reused,
    getPeerCertificate: () => (fp ? { fingerprint256: fp } : {}),
  } as any;
}

test("TlsPinGuard: first certificate becomes the pin for the rest of the operation", () => {
  const guard = new TlsPinGuard(null);
  assert.equal(guard.check(fakeSocket(FP_A)), null);
  assert.equal(guard.observed, normalizeFingerprint(FP_A));
  assert.equal(guard.check(fakeSocket(FP_A)), null);
  const err = guard.check(fakeSocket(FP_B)) as Error & { code?: string };
  assert.equal(err?.code, "TLS_PIN_MISMATCH");
});

test("TlsPinGuard: a stored pin is enforced and never replaced", () => {
  const guard = new TlsPinGuard(FP_A);
  assert.equal(guard.check(fakeSocket(FP_A)), null);
  assert.equal(guard.observed, null);
  assert.ok(guard.check(fakeSocket(FP_B)));
  assert.equal(guard.check(fakeSocket(FP_B, true)), null); // CA-valid replacement is fine…
  assert.equal(guard.toPersist, CA_VALID_PIN); // …and replaces the fingerprint pin
  assert.ok(guard.check(fakeSocket(FP_A))); // so the old self-signed cert is now refused
});

test("TlsPinGuard: a CA-valid server is recorded, and a later self-signed (MITM) certificate is refused", () => {
  const first = new TlsPinGuard(null);
  assert.equal(first.check(fakeSocket(FP_A, true)), null);
  assert.equal(first.toPersist, CA_VALID_PIN);
  assert.ok(first.check(fakeSocket(FP_B))); // same operation
  const later = new TlsPinGuard(CA_VALID_PIN);
  assert.equal(later.check(fakeSocket(FP_B, true)), null); // renewed CA cert
  assert.equal(later.toPersist, null);
  const err = later.check(fakeSocket(FP_B)) as Error & { code?: string };
  assert.equal(err?.code, "TLS_PIN_MISMATCH");
});
