import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConnectionIds } from "../src/lib/connectionIds.ts";

test("normalises a JSON array to CSV", () => {
  assert.equal(normalizeConnectionIds("[1,2,3]"), "1,2,3");
});

test("normalises a CSV string", () => {
  assert.equal(normalizeConnectionIds("4, 5 ,6"), "4,5,6");
});

test("normalises a single value", () => {
  assert.equal(normalizeConnectionIds("7"), "7");
  assert.equal(normalizeConnectionIds("[7]"), "7");
});

test("drops non-positive and junk entries; truncates floats (parseInt)", () => {
  // -2 and 0 dropped; "x" dropped; 4.5 -> 4 (parseInt truncation, acceptable
  // since ids are re-validated for ownership at upload time).
  assert.equal(normalizeConnectionIds("[1, -2, 0, 3, \"x\", 4.5]"), "1,3,4");
  assert.equal(normalizeConnectionIds("1,abc,2,,3"), "1,2,3");
});

test("returns null for empty / all-invalid input", () => {
  for (const v of [null, undefined, "", "[]", "abc", "0,-1", "[\"x\"]"]) {
    assert.equal(normalizeConnectionIds(v), null, JSON.stringify(v));
  }
});
