import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Both modules read SESSION_SECRET (crypto.ts at load, twoFactor.ts lazily).
process.env["SESSION_SECRET"] ??= "test-session-secret-0123456789abcdef-padding";
const { encrypt, decrypt } = await import("../src/lib/crypto.ts");
const { authenticator } = await import("@otplib/preset-default");
const {
  totpStepAt, matchTotpStep, isTotpStepFresh, isPlaintextTotpSecret, openTotpSecret,
  generateBackupCode, generateBackupCodes, normalizeBackupCode, hashBackupCode,
  backupCodeCandidates, spendBackupCode, BACKUP_CODE_COUNT,
} = await import("../src/lib/twoFactor.ts");

const SECRET = authenticator.generateSecret();
const NOW = 1_750_000_000_000;
const codeAt = (ms: number) => authenticator.clone({ epoch: ms }).generate(SECRET);

// ─── TOTP steps ──────────────────────────────────────────────────────────────

test("totp: a current code matches the current step", () => {
  assert.equal(matchTotpStep(codeAt(NOW), SECRET, NOW), totpStepAt(NOW));
});

test("totp: a code from another step doesn't match (window 0)", () => {
  const prev = codeAt(NOW - 30_000);
  if (prev !== codeAt(NOW)) assert.equal(matchTotpStep(prev, SECRET, NOW), null);
});

test("totp: rejects non-6-digit input and a bad secret without throwing", () => {
  assert.equal(matchTotpStep("12345", SECRET, NOW), null);
  assert.equal(matchTotpStep("ABCDEF", SECRET, NOW), null);
  assert.equal(matchTotpStep(codeAt(NOW), "", NOW), null);
  assert.equal(matchTotpStep(codeAt(NOW), "!!not-base32!!", NOW), null);
});

test("totp: step boundaries are 30s", () => {
  assert.equal(totpStepAt(0), 0);
  assert.equal(totpStepAt(29_999), 0);
  assert.equal(totpStepAt(30_000), 1);
});

test("totp replay: only a step after the last accepted one is fresh", () => {
  assert.equal(isTotpStepFresh(100, null), true);
  assert.equal(isTotpStepFresh(100, undefined), true);
  assert.equal(isTotpStepFresh(101, 100), true);
  assert.equal(isTotpStepFresh(100, 100), false); // same code again
  assert.equal(isTotpStepFresh(99, 100), false);
});

// ─── Secret at rest ──────────────────────────────────────────────────────────

test("secret: encrypted value opens to the secret, not flagged legacy", () => {
  assert.deepEqual(openTotpSecret(encrypt(SECRET), decrypt), { secret: SECRET, legacyPlaintext: false });
});

test("secret: legacy plaintext base32 is accepted and flagged for re-encryption", () => {
  assert.ok(isPlaintextTotpSecret(SECRET));
  assert.deepEqual(openTotpSecret(SECRET, decrypt), { secret: SECRET, legacyPlaintext: true });
});

test("secret: fails closed on empty, garbage, or undecryptable ciphertext", () => {
  assert.equal(openTotpSecret(null, decrypt), null);
  assert.equal(openTotpSecret("", decrypt), null);
  assert.equal(openTotpSecret("not a secret!", decrypt), null);
  const parts = encrypt(SECRET).split(":");
  parts[3] = parts[3]!.slice(0, -1) + (parts[3]!.endsWith("0") ? "1" : "0");
  assert.equal(openTotpSecret(parts.join(":"), decrypt), null);
});

// ─── Backup codes ────────────────────────────────────────────────────────────

test("backup: codes are XXXXX-XXXXX Crockford base32 with no I/L/O/U", () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, BACKUP_CODE_COUNT);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(new Set(codes).size, codes.length);
});

test("backup: normalisation strips spaces/dashes, uppercases, maps look-alikes", () => {
  assert.equal(normalizeBackupCode(" ab1cd-ef2gh "), "AB1CDEF2GH");
  assert.equal(normalizeBackupCode("o0il1-xxxxx"), "00111XXXXX");
});

test("backup: stored hash is keyed HMAC (prefixed), not bare SHA-256", () => {
  const code = generateBackupCode();
  const h = hashBackupCode(code);
  assert.ok(h.startsWith("h1:"));
  const normalized = normalizeBackupCode(code);
  assert.notEqual(h.slice(3), createHash("sha256").update(normalized).digest("hex"));
  // Same code in any typed form hashes the same.
  assert.equal(hashBackupCode(code.toLowerCase().replace("-", " ")), h);
});

test("backup: new code verifies in any typed form and is single-use", () => {
  const code = generateBackupCode();
  const other = generateBackupCode();
  const stored = [hashBackupCode(other), hashBackupCode(code)];
  const after = spendBackupCode(stored, code.replace("-", "").toLowerCase());
  assert.deepEqual(after, [hashBackupCode(other)]);
  assert.equal(spendBackupCode(after!, code), null);
});

test("backup: legacy 8-hex SHA-256 codes still verify", () => {
  const legacy = "A1B2C3D4";
  const stored = [createHash("sha256").update(legacy).digest("hex")];
  assert.deepEqual(spendBackupCode(stored, "a1b2 c3d4"), []);
});

test("backup: wrong or malformed input never matches (and needs no hashing)", () => {
  const stored = [hashBackupCode(generateBackupCode())];
  assert.equal(spendBackupCode(stored, generateBackupCode()), null);
  assert.deepEqual(backupCodeCandidates("123456"), []);   // a TOTP code
  assert.deepEqual(backupCodeCandidates(""), []);
  assert.deepEqual(backupCodeCandidates("ABCDEFGHJKM"), []); // 11 chars
  assert.equal(spendBackupCode([], "A1B2C3D4"), null);
});
