import { test } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { redactPassText, redactSerializedError } from "../src/lib/logRedaction.ts";

test("redactPassText: strips an echoed PASS command, leaves other text alone", () => {
  assert.equal(redactPassText("500 'PASS hunter2': command not understood"), "500 'PASS [redacted]");
  assert.equal(redactPassText("530 Login incorrect"), "530 Login incorrect");
  assert.equal(redactPassText("password reset failed"), "password reset failed");
});

test("redactSerializedError: message, stack and nested cause are scrubbed (as the logger's err serializer does)", () => {
  const cause = Object.assign(new Error("421 PASS s3cret"), { code: 421 });
  const err = Object.assign(new Error("500 'PASS hunter2': command not understood", { cause }), { code: 500 });
  const out = redactSerializedError(pino.stdSerializers.err(err)) as Record<string, any>;
  const text = JSON.stringify(out);
  assert.equal(text.includes("hunter2"), false);
  assert.equal(text.includes("s3cret"), false);
  assert.equal(out.code, 500);
  assert.match(out.message, /PASS \[redacted\]/);
});

test("redactSerializedError: unchanged values are returned as-is", () => {
  const ser = pino.stdSerializers.err(new Error("530 Login incorrect"));
  assert.equal(redactSerializedError(ser), ser);
  assert.equal(redactSerializedError("x"), "x");
  assert.equal(redactSerializedError(null), null);
  const cyclic: Record<string, unknown> = { message: "ok" };
  cyclic.self = cyclic;
  assert.equal(redactSerializedError(cyclic), cyclic);
});
