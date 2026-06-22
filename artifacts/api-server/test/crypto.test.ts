import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";

// crypto.ts reads SESSION_SECRET at module load, so set it before importing.
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef-padding";
const { encrypt, decrypt } = await import("../src/lib/crypto.ts");

test("GCM round-trips and uses the gcm: format", () => {
  const enc = encrypt("hello secret");
  assert.ok(enc.startsWith("gcm:"), enc);
  assert.equal(decrypt(enc), "hello secret");
});

test("round-trips empty string and unicode", () => {
  assert.equal(decrypt(encrypt("")), "");
  const s = "pȧsswörd🔐 — Ω";
  assert.equal(decrypt(encrypt(s)), s);
});

test("each encryption uses a fresh IV (ciphertexts differ)", () => {
  assert.notEqual(encrypt("same"), encrypt("same"));
});

test("tampered GCM ciphertext fails closed (returns '')", () => {
  const parts = encrypt("sensitive-token").split(":");
  const last = parts[3]!;
  parts[3] = last.slice(0, -1) + (last.slice(-1) === "0" ? "1" : "0"); // flip a hex nibble
  assert.equal(decrypt(parts.join(":")), "");
});

test("malformed / empty input returns '' rather than throwing", () => {
  for (const bad of ["garbage", "gcm:only", "gcm::: ", "", "a:b:c"]) {
    assert.equal(decrypt(bad), "");
  }
});

test("legacy AES-256-CBC values still decrypt (backward compat)", () => {
  const key = Buffer.from(process.env.SESSION_SECRET!.slice(0, 32).padEnd(32, "\0").slice(0, 32));
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([cipher.update("legacy-credential"), cipher.final()]);
  const legacy = `${iv.toString("hex")}:${data.toString("hex")}`;
  assert.equal(decrypt(legacy), "legacy-credential");
});
