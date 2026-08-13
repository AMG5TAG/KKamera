import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectionSchema, updateConnectionSchema } from "../src/lib/cloudConnectionSchemas.ts";
import { CLOUD_PROVIDER } from "../src/lib/constants.ts";

test("inlined provider list still matches the canonical constants (drift guard)", () => {
  // cloudConnectionSchemas.ts inlines the provider list to stay dependency-free.
  // Every CLOUD_PROVIDER value must be accepted, and nothing else.
  for (const type of Object.values(CLOUD_PROVIDER)) {
    const r = createConnectionSchema.safeParse({ type, name: "n", host: "h.example.com", username: "u" });
    assert.equal(r.success, true, `${type} should be accepted`);
  }
});

// The app's manual (non-OAuth) connection form sends an explicit null for every
// field that doesn't apply — `oauthCode` is always null there, and `provider` is
// null for anything that isn't a sub-flavour like Synology. The OpenAPI spec
// declares all of these `["string", "null"]`, so the server must accept them.
// It previously used `.optional()` (undefined only) and rejected every manual
// connection with "Expected string, received null".
function appBody(over: Record<string, unknown> = {}) {
  return {
    type: "nextcloud",
    provider: null,
    name: "My Nextcloud",
    host: "https://cloud.example.com",
    port: null,
    username: "alice",
    password: "app-password",
    uploadPath: "/KKamera",
    oauthCode: null,
    ...over,
  };
}

test("accepts the nulls the app sends for a Nextcloud connection", () => {
  const r = createConnectionSchema.safeParse(appBody());
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.errors));
});

test("accepts the same null-laden body for every manual provider", () => {
  for (const [type, host] of [["webdav", "https://dav.example.com"], ["ftp", "ftp.example.com"]] as const) {
    const r = createConnectionSchema.safeParse(appBody({ type, host }));
    assert.equal(r.success, true, `${type}: ${r.success ? "" : JSON.stringify(r.error.errors)}`);
  }
});

test("accepts a Synology sub-flavour (provider set, oauthCode null)", () => {
  const r = createConnectionSchema.safeParse(
    appBody({ type: "webdav", provider: "synology", port: 5006 }),
  );
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.errors));
});

test("omitted fields are still fine (undefined as well as null)", () => {
  const r = createConnectionSchema.safeParse({
    type: "ftp", name: "Box", host: "ftp.example.com",
  });
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.errors));
});

test("rejects an unknown provider type", () => {
  const r = createConnectionSchema.safeParse(appBody({ type: "mega" }));
  assert.equal(r.success, false);
});

test("still enforces name and type", () => {
  assert.equal(createConnectionSchema.safeParse(appBody({ name: "" })).success, false);
  assert.equal(createConnectionSchema.safeParse(appBody({ name: undefined })).success, false);
  assert.equal(createConnectionSchema.safeParse(appBody({ type: undefined })).success, false);
});

test("Nextcloud requires a server URL and a username", () => {
  // null / whitespace-only reach the cross-field check and get the tailored
  // message; "" is caught earlier by the field's own min(1) — both rejected,
  // both pointing at the offending field.
  for (const bad of [{ host: null }, { host: "   " }]) {
    const r = createConnectionSchema.safeParse(appBody(bad));
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.errors[0]!.message, /server URL is required/);
  }
  for (const bad of [{ username: null }, { username: "  " }]) {
    const r = createConnectionSchema.safeParse(appBody(bad));
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.errors[0]!.message, /username is required/);
  }
  for (const bad of [{ host: "" }, { username: "" }] as const) {
    const r = createConnectionSchema.safeParse(appBody(bad));
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.errors[0]!.path[0], Object.keys(bad)[0]);
  }
});

test("the Nextcloud requirement does not leak onto other providers", () => {
  // A WebDAV connection may legitimately have no username (anonymous share).
  const r = createConnectionSchema.safeParse(appBody({ type: "webdav", username: null }));
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.errors));
});

test("still enforces field bounds", () => {
  assert.equal(createConnectionSchema.safeParse(appBody({ port: 0 })).success, false);
  assert.equal(createConnectionSchema.safeParse(appBody({ port: 70000 })).success, false);
  assert.equal(createConnectionSchema.safeParse(appBody({ port: 8443 })).success, true);
  assert.equal(createConnectionSchema.safeParse(appBody({ name: "x".repeat(101) })).success, false);
  assert.equal(createConnectionSchema.safeParse(appBody({ host: "x".repeat(501) })).success, false);
});

test("update accepts nulls and the toggle the list screen sends", () => {
  assert.equal(updateConnectionSchema.safeParse({ active: false }).success, true);
  assert.equal(updateConnectionSchema.safeParse({ name: null, active: null }).success, true);
  assert.equal(updateConnectionSchema.safeParse({ uploadPath: null, password: null }).success, true);
});

test("update still rejects unknown keys", () => {
  assert.equal(updateConnectionSchema.safeParse({ type: "ftp" }).success, false);
  assert.equal(updateConnectionSchema.safeParse({ userId: 1 }).success, false);
});
