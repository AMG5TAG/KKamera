import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFileName } from "../src/lib/fileNames.ts";

test("keeps a plain filename", () => {
  assert.equal(sanitizeFileName("photo.jpg"), "photo.jpg");
});

test("strips POSIX path traversal", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("/var/www/secret.png"), "secret.png");
});

test("strips Windows path traversal", () => {
  assert.equal(sanitizeFileName("..\\..\\windows\\system32\\x.dll"), "x.dll");
  assert.equal(sanitizeFileName("C:\\Users\\me\\pic.jpg"), "pic.jpg");
});

test("removes leading dots (no hidden/traversal files)", () => {
  assert.equal(sanitizeFileName("...hidden.mov"), "hidden.mov");
  assert.equal(sanitizeFileName("../.../a.txt"), "a.txt");
});

test("falls back to a generated name when nothing usable remains", () => {
  for (const input of ["", "/", "..", "...", "   ", "../../"]) {
    assert.match(sanitizeFileName(input), /^upload_\d+$/, JSON.stringify(input));
  }
});
