import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_UPLOADING_MS,
  decideExistingUpload,
  isUniqueViolation,
  mergeUploadOutcome,
  parseClientUploadIdField,
  parseStoredConnectionIds,
} from "../src/lib/uploadDedupe.ts";
import { MAX_UPLOAD_DEADLINE_MS } from "../src/lib/cloudUploadPolicy.ts";

test("a row is only considered stale well after the longest possible upload", () => {
  assert.ok(STALE_UPLOADING_MS >= MAX_UPLOAD_DEADLINE_MS + 60_000);
});

test("clientUploadId: absent/empty means no dedupe; present must be ≤100 chars of [A-Za-z0-9_-]", () => {
  assert.deepEqual(parseClientUploadIdField(undefined), { ok: true, id: null });
  assert.deepEqual(parseClientUploadIdField(""), { ok: true, id: null });
  assert.deepEqual(parseClientUploadIdField("1727500000000abc12_x-Y"), { ok: true, id: "1727500000000abc12_x-Y" });
  assert.deepEqual(parseClientUploadIdField("a".repeat(100)), { ok: true, id: "a".repeat(100) });
  for (const bad of ["a".repeat(101), "a b", "a/b", "a.b", "é", "id\n", 42, ["a"], {}]) {
    assert.equal(parseClientUploadIdField(bad).ok, false, JSON.stringify(bad));
  }
});

test("decideExistingUpload: insert / done / busy / reuse", () => {
  const now = Date.now();
  const fresh = new Date(now - 1000);
  assert.deepEqual(decideExistingUpload(undefined, now), { action: "insert" });
  assert.deepEqual(decideExistingUpload(null, now), { action: "insert" });
  assert.deepEqual(decideExistingUpload({ status: "done", updatedAt: fresh }, now), { action: "done" });
  assert.deepEqual(decideExistingUpload({ status: "uploading", updatedAt: fresh }, now), { action: "busy" });
  for (const status of ["partial", "failed", "pending", "queued"]) {
    assert.deepEqual(decideExistingUpload({ status, updatedAt: fresh }, now), { action: "reuse" }, status);
  }
});

test("decideExistingUpload: a stale 'uploading' row (dead request) is reclaimed", () => {
  const now = Date.now();
  const stale = new Date(now - STALE_UPLOADING_MS - 1);
  assert.deepEqual(decideExistingUpload({ status: "uploading", updatedAt: stale }, now), { action: "reuse" });
  // A stale done row is still done.
  assert.deepEqual(decideExistingUpload({ status: "done", updatedAt: stale }, now), { action: "done" });
});

test("mergeUploadOutcome: first attempt", () => {
  assert.deepEqual(
    mergeUploadOutcome(null, [{ connectionId: 1, success: true }, { connectionId: 2, success: true }]),
    { status: "done", connectionIds: "1,2", error: null },
  );
  assert.deepEqual(
    mergeUploadOutcome(null, [{ connectionId: 1, success: true }, { connectionId: 2, success: false, error: "Dropbox failed" }]),
    { status: "partial", connectionIds: "1,2", error: "Dropbox failed" },
  );
  assert.deepEqual(
    mergeUploadOutcome(null, [{ connectionId: 1, success: false, error: "A" }, { connectionId: 2, success: false, error: "B" }]),
    { status: "failed", connectionIds: "1,2", error: "A; B" },
  );
});

test("mergeUploadOutcome: partial retry of only the failed destinations", () => {
  const prev = { status: "partial", connectionIds: "1,2,3" };
  // The one that failed now succeeds → the capture is everywhere.
  assert.deepEqual(
    mergeUploadOutcome(prev, [{ connectionId: 2, success: true }]),
    { status: "done", connectionIds: "1,2,3", error: null },
  );
  // Still failing → stays partial (earlier destinations have it), not "failed".
  assert.deepEqual(
    mergeUploadOutcome(prev, [{ connectionId: 2, success: false, error: "Drive failed" }]),
    { status: "partial", connectionIds: "1,2,3", error: "Drive failed" },
  );
});

test("mergeUploadOutcome: retry after a failed/queued attempt", () => {
  assert.deepEqual(
    mergeUploadOutcome({ status: "failed", connectionIds: "1" }, [{ connectionId: 1, success: false, error: "X" }]),
    { status: "failed", connectionIds: "1", error: "X" },
  );
  assert.deepEqual(
    mergeUploadOutcome({ status: "queued", connectionIds: null }, [{ connectionId: 4, success: true }]),
    { status: "done", connectionIds: "4", error: null },
  );
  // A new destination joins the stored set.
  assert.equal(
    mergeUploadOutcome({ status: "failed", connectionIds: "1" }, [{ connectionId: 5, success: true }]).connectionIds,
    "1,5",
  );
});

test("parseStoredConnectionIds tolerates junk", () => {
  assert.deepEqual(parseStoredConnectionIds(null), []);
  assert.deepEqual(parseStoredConnectionIds(""), []);
  assert.deepEqual(parseStoredConnectionIds("1, 2,x,,0,-3,4"), [1, 2, 4]);
});

test("isUniqueViolation recognises raw and drizzle-wrapped pg errors", () => {
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation({ message: "wrapped", cause: { code: "23505" } }), true);
  assert.equal(isUniqueViolation({ code: "23503" }), false);
  assert.equal(isUniqueViolation(new Error("x")), false);
  assert.equal(isUniqueViolation(null), false);
});
