import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebsiteRequest } from "../src/lib/websitePaths.ts";

test("website answers GET/HEAD outside /api", () => {
  assert.equal(isWebsiteRequest("GET", "/"), true);
  assert.equal(isWebsiteRequest("HEAD", "/privacy"), true);
  assert.equal(isWebsiteRequest("GET", "/auth/register"), true);
  assert.equal(isWebsiteRequest("GET", "/apis"), true);
});

test("website never shadows the API or non-GET requests", () => {
  assert.equal(isWebsiteRequest("GET", "/api"), false);
  assert.equal(isWebsiteRequest("GET", "/api/healthz"), false);
  assert.equal(isWebsiteRequest("POST", "/"), false);
  assert.equal(isWebsiteRequest("PUT", "/privacy"), false);
});
