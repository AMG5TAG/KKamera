import { test } from "node:test";
import assert from "node:assert/strict";
import { isTesterEmail, parseTesterEmails } from "../src/lib/testerAccess.ts";

test("parseTesterEmails trims, lower-cases and drops junk", () => {
  assert.deepEqual([...parseTesterEmails(" A@x.com , b@Y.com,, nope ,")], ["a@x.com", "b@y.com"]);
  assert.equal(parseTesterEmails(undefined).size, 0);
});

test("isTesterEmail matches exactly, case-insensitively", () => {
  const raw = "tester@koastal.com.au,other@example.com";
  assert.equal(isTesterEmail("Tester@Koastal.com.au", raw), true);
  assert.equal(isTesterEmail("tester+1@koastal.com.au", raw), false);
  assert.equal(isTesterEmail("someone@example.com", raw), false);
  assert.equal(isTesterEmail(null, raw), false);
  assert.equal(isTesterEmail("tester@koastal.com.au", ""), false);
});
