import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicBaseUrl, getPublicHost } from "../src/lib/appUrl.ts";

test("defaults to app.kkamera.app when APP_URL is unset", () => {
  delete process.env.APP_URL;
  assert.equal(getPublicBaseUrl(), "https://app.kkamera.app");
  assert.equal(getPublicHost(), "app.kkamera.app");
});

test("uses the APP_URL override and strips trailing slashes", () => {
  process.env.APP_URL = "https://staging.example.com/";
  assert.equal(getPublicBaseUrl(), "https://staging.example.com");
  assert.equal(getPublicHost(), "staging.example.com");
  delete process.env.APP_URL;
});

test("ignores an empty/whitespace APP_URL", () => {
  process.env.APP_URL = "   ";
  assert.equal(getPublicBaseUrl(), "https://app.kkamera.app");
  delete process.env.APP_URL;
});

test("getPublicHost falls back to app.kkamera.app on an unparseable APP_URL", () => {
  process.env.APP_URL = "not a url";
  assert.equal(getPublicHost(), "app.kkamera.app");
  delete process.env.APP_URL;
});
