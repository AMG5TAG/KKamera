import { test } from "node:test";
import assert from "node:assert/strict";

process.env["SESSION_SECRET"] ??= "test-secret-test-secret-test-secret-1234";
const { normalizeEmailForTrial, emailTrialHash, emailTrialHashes } = await import("../src/lib/emailHash.ts");

test("trial normaliser: lowercases and trims", () => {
  assert.equal(normalizeEmailForTrial("  Jane@Example.COM "), "jane@example.com");
});

test("trial normaliser: strips +tag on any domain, keeps dots off-Gmail", () => {
  assert.equal(normalizeEmailForTrial("jane+trial2@example.com"), "jane@example.com");
  assert.equal(normalizeEmailForTrial("j.ane+a+b@outlook.com"), "j.ane@outlook.com");
});

test("trial normaliser: Gmail ignores dots and maps googlemail.com", () => {
  assert.equal(normalizeEmailForTrial("J.Doe+x@gmail.com"), "jdoe@gmail.com");
  assert.equal(normalizeEmailForTrial("j.d.o.e@googlemail.com"), "jdoe@gmail.com");
  assert.equal(normalizeEmailForTrial("jdoe@GoogleMail.com"), "jdoe@gmail.com");
});

test("trial normaliser: degenerate inputs are left alone", () => {
  assert.equal(normalizeEmailForTrial("+tag@example.com"), "+tag@example.com");
  assert.equal(normalizeEmailForTrial("noatsign"), "noatsign");
  assert.equal(normalizeEmailForTrial("a@"), "a@");
  assert.equal(normalizeEmailForTrial("...@gmail.com"), "...@gmail.com");
});

test("trial hashes: legacy hash always first; alias hash added only when different", () => {
  assert.deepEqual(emailTrialHashes("jane@example.com"), [emailTrialHash("jane@example.com")]);
  const hs = emailTrialHashes("J.Doe+x@googlemail.com");
  assert.equal(hs.length, 2);
  assert.equal(hs[0], emailTrialHash("J.Doe+x@googlemail.com"));
  // Every alias of the mailbox shares the normalised hash.
  assert.ok(emailTrialHashes("jdoe@gmail.com").includes(hs[1]!));
  assert.ok(emailTrialHashes("jd.oe+other@gmail.com").includes(hs[1]!));
});
