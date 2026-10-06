import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppLink } from "../src/lib/appLinks.ts";

const TOKEN = "a".repeat(64);

test("password reset link forwards a well-formed token to the app", () => {
  const link = buildAppLink("/auth/reset-password", { token: TOKEN });
  assert.deepEqual(link, {
    title: "Reset your password",
    deepLink: `kkamera://auth/reset-password?token=${TOKEN}`,
    valid: true,
  });
});

test("password reset link with a missing or malformed token is invalid", () => {
  assert.equal(buildAppLink("/auth/reset-password", {})?.valid, false);
  assert.equal(buildAppLink("/auth/reset-password", { token: "nothex" })?.valid, false);
  assert.equal(buildAppLink("/auth/reset-password", { token: [TOKEN] })?.valid, false);
  assert.equal(buildAppLink("/auth/reset-password", { token: "zz" })?.deepLink, "kkamera://auth/reset-password");
});

test("invite link forwards the referral code and tolerates its absence", () => {
  assert.equal(buildAppLink("/auth/register", { ref: "ABC-123" })?.deepLink, "kkamera://auth/register?ref=ABC-123");
  const bare = buildAppLink("/auth/register", { ref: "<script>" });
  assert.equal(bare?.deepLink, "kkamera://auth/register");
  assert.equal(bare?.valid, true);
});

test("unknown params are dropped and unknown paths are rejected", () => {
  assert.equal(
    buildAppLink("/settings/subscription", { next: "https://evil.example" })?.deepLink,
    "kkamera://settings/subscription",
  );
  assert.equal(buildAppLink("/api/users", {}), null);
  assert.equal(buildAppLink("/auth/reset-password/../x", {}), null);
});
