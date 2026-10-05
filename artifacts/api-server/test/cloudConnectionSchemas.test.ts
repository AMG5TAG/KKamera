import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OAUTH_ONLY_PROVIDERS, connectionUpdatePlan, createConnectionSchema, hostHasUserinfo, updateConnectionSchema,
} from "../src/lib/cloudConnectionSchemas.ts";
import { hasParentSegment } from "../src/lib/cloudUploadPolicy.ts";
import { CLOUD_PROVIDER } from "../src/lib/constants.ts";

test("inlined provider list still matches the canonical constants (drift guard)", () => {
  // cloudConnectionSchemas.ts inlines the provider list to stay dependency-free.
  // Every manual CLOUD_PROVIDER value must be accepted; every OAuth one must be
  // refused with the tailored message (not "invalid enum value" — i.e. the
  // enum still knows it).
  for (const type of Object.values(CLOUD_PROVIDER)) {
    const r = createConnectionSchema.safeParse({ type, name: "n", host: "h.example.com", username: "u" });
    if (OAUTH_ONLY_PROVIDERS.has(type)) {
      assert.equal(r.success, false, `${type} must be refused on manual create`);
      if (!r.success) assert.match(r.error.errors[0]!.message, /signing in/);
    } else {
      assert.equal(r.success, true, `${type} should be accepted`);
    }
  }
  for (const type of OAUTH_ONLY_PROVIDERS) {
    assert.ok((Object.values(CLOUD_PROVIDER) as string[]).includes(type), type);
  }
});

test("manual create never accepts an OAuth token", () => {
  // Legacy app builds send oauthCode: null — still fine.
  assert.equal(createConnectionSchema.safeParse(appBody({ oauthCode: null })).success, true);
  assert.equal(createConnectionSchema.safeParse(appBody({ oauthCode: undefined })).success, true);
  const r = createConnectionSchema.safeParse(appBody({ oauthCode: "ya29.token" }));
  assert.equal(r.success, false);
  if (!r.success) assert.equal(r.error.errors[0]!.path[0], "oauthCode");
  // OAuth types are refused even with a token, and with no host at all.
  for (const type of ["googledrive", "onedrive", "dropbox"]) {
    const bad = createConnectionSchema.safeParse({ type, name: "Drive", oauthCode: "code" });
    assert.equal(bad.success, false, type);
    if (!bad.success) assert.equal(bad.error.errors[0]!.path[0], "type");
  }
  // And a PATCH can no longer swap in a token.
  assert.equal(updateConnectionSchema.safeParse({ oauthCode: "ya29.token" }).success, false);
});

test("hosts with embedded credentials are rejected on create and update", () => {
  for (const bad of [
    "https://user:pw@nas.example.com", "https://user@nas.example.com/dav", "user:pw@ftp.example.com",
    "ftp://u@ftp.example.com:21", " https://a:b@cloud.example.com ", "webdavs://x@y.example.com",
  ]) {
    assert.equal(hostHasUserinfo(bad), true, bad);
    const c = createConnectionSchema.safeParse(appBody({ host: bad }));
    assert.equal(c.success, false, bad);
    if (!c.success) assert.equal(c.error.errors[0]!.message, "Put the username and password in their own fields");
    const u = updateConnectionSchema.safeParse({ host: bad });
    assert.equal(u.success, false, bad);
    if (!u.success) assert.equal(u.error.errors[0]!.message, "Put the username and password in their own fields");
  }
  // An "@" after the authority (path / query) is not userinfo.
  for (const ok of [
    "https://cloud.example.com", "ftp.example.com", "https://dav.example.com/remote.php/dav/files/a@b.com",
    "https://nas.example.com:5006/?u=a@b", "[2606:4700::1111]:8443",
  ]) {
    assert.equal(hostHasUserinfo(ok), false, ok);
    assert.equal(createConnectionSchema.safeParse(appBody({ host: ok })).success, true, ok);
  }
});

test("name, username and host are trimmed and must be single-line", () => {
  const r = createConnectionSchema.parse(appBody({ name: "  My NAS  ", username: " alice ", host: " https://cloud.example.com " }));
  assert.equal(r.name, "My NAS");
  assert.equal(r.username, "alice");
  assert.equal(r.host, "https://cloud.example.com");
  for (const field of ["name", "username", "host", "uploadPath"] as const) {
    for (const v of ["a\nb", "a\u0000b", "a\tb", "a\u007fb", "a\rb"]) {
      assert.equal(createConnectionSchema.safeParse(appBody({ [field]: v })).success, false, `${field} ${JSON.stringify(v)}`);
      assert.equal(updateConnectionSchema.safeParse({ [field]: v }).success, false, `update ${field} ${JSON.stringify(v)}`);
    }
  }
  // Whitespace-only name is empty after trimming.
  assert.equal(createConnectionSchema.safeParse(appBody({ name: "   " })).success, false);
  assert.equal(updateConnectionSchema.safeParse({ name: "   " }).success, false);
  assert.equal(updateConnectionSchema.parse({ name: " Box " }).name, "Box");
  assert.equal(createConnectionSchema.safeParse(appBody({ username: "x".repeat(201) })).success, false);
  assert.equal(updateConnectionSchema.safeParse({ username: "x".repeat(201) }).success, false);
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
    oauthCode: null, // legacy field older builds still send
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
  for (const bad of [{ host: null }]) {
    const r = createConnectionSchema.safeParse(appBody(bad));
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.errors[0]!.message, /server URL is required/);
  }
  for (const bad of [{ username: null }, { username: "  " }]) {
    const r = createConnectionSchema.safeParse(appBody(bad));
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.errors[0]!.message, /username is required/);
  }
  for (const bad of [{ host: "" }, { host: "   " }, { username: "" }] as const) {
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

test("update: the toggle the list screen sends", () => {
  assert.equal(updateConnectionSchema.safeParse({ active: false }).success, true);
});

test("update: absent = unchanged, null = clear", () => {
  // Absent fields produce no change at all.
  assert.deepEqual(connectionUpdatePlan(updateConnectionSchema.parse({})), {});
  assert.deepEqual(connectionUpdatePlan(updateConnectionSchema.parse({ active: true })), { active: true });
  // Explicit null clears the clearable fields.
  const cleared = connectionUpdatePlan(updateConnectionSchema.parse({
    password: null, port: null, username: null, uploadPath: null,
  }));
  assert.deepEqual(cleared, { password: null, port: null, username: null, uploadPath: null });
  // Values are passed through; blank username / empty password clear too.
  assert.deepEqual(
    connectionUpdatePlan(updateConnectionSchema.parse({ password: "s3cret", port: 2121, username: "bob" })),
    { password: "s3cret", port: 2121, username: "bob" },
  );
  assert.deepEqual(
    connectionUpdatePlan(updateConnectionSchema.parse({ password: "", username: "  " })),
    { password: null, username: null },
  );
});

test("update: host must be non-blank and cannot be cleared; name/active are not nullable", () => {
  for (const host of ["", "   ", null]) {
    assert.equal(updateConnectionSchema.safeParse({ host }).success, false, JSON.stringify(host));
  }
  assert.equal(updateConnectionSchema.safeParse({ host: " ftp.example.com " }).success, true);
  assert.equal(updateConnectionSchema.parse({ host: " ftp.example.com " }).host, "ftp.example.com");
  assert.equal(updateConnectionSchema.safeParse({ name: null }).success, false);
  assert.equal(updateConnectionSchema.safeParse({ active: null }).success, false);
  assert.equal(updateConnectionSchema.safeParse({ name: "" }).success, false);
  assert.equal(updateConnectionSchema.safeParse({ oauthCode: null }).success, false); // no longer a field
});

test("upload paths with '..' segments are rejected on create and update", () => {
  for (const bad of ["..", "/..", "../etc", "/a/../b", "a\\..\\b", "/a/ .. /b"]) {
    assert.equal(createConnectionSchema.safeParse(appBody({ uploadPath: bad })).success, false, bad);
    assert.equal(updateConnectionSchema.safeParse({ uploadPath: bad }).success, false, bad);
    // The inlined schema check agrees with the shared helper.
    assert.equal(hasParentSegment(bad), true, bad);
  }
  for (const ok of ["/KKamera", "Photos/KKamera", "/a..b/c", "/...", "\\Photos\\2024", "/", ""]) {
    assert.equal(createConnectionSchema.safeParse(appBody({ uploadPath: ok })).success, true, ok);
    assert.equal(updateConnectionSchema.safeParse({ uploadPath: ok }).success, true, ok);
    assert.equal(hasParentSegment(ok), false, ok);
  }
  assert.equal(updateConnectionSchema.safeParse({ uploadPath: "/a\nb" }).success, false);
});

test("update still rejects unknown keys", () => {
  assert.equal(updateConnectionSchema.safeParse({ type: "ftp" }).success, false);
  assert.equal(updateConnectionSchema.safeParse({ userId: 1 }).success, false);
});
