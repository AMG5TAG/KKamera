import { test } from "node:test";
import assert from "node:assert/strict";
import { nextcloudDavUrl } from "../src/lib/nextcloud.ts";

test("derives the files endpoint from a plain server URL", () => {
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com", "alice"),
    "https://cloud.example.com/remote.php/dav/files/alice",
  );
});

test("defaults to https when no scheme is given", () => {
  assert.equal(
    nextcloudDavUrl("cloud.example.com", "alice"),
    "https://cloud.example.com/remote.php/dav/files/alice",
  );
});

test("keeps a subfolder install's base path", () => {
  assert.equal(
    nextcloudDavUrl("https://example.com/nextcloud", "alice"),
    "https://example.com/nextcloud/remote.php/dav/files/alice",
  );
});

test("tolerates trailing slashes", () => {
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com///", "alice"),
    "https://cloud.example.com/remote.php/dav/files/alice",
  );
  assert.equal(
    nextcloudDavUrl("https://example.com/nextcloud/", "alice"),
    "https://example.com/nextcloud/remote.php/dav/files/alice",
  );
});

test("applies the separate port field, but an explicit port in the URL wins", () => {
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com", "alice", 8443),
    "https://cloud.example.com:8443/remote.php/dav/files/alice",
  );
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com:9000", "alice", 8443),
    "https://cloud.example.com:9000/remote.php/dav/files/alice",
  );
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com", "alice", null),
    "https://cloud.example.com/remote.php/dav/files/alice",
  );
});

test("percent-encodes usernames that contain URL-significant characters", () => {
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com", "alice@example.com"),
    "https://cloud.example.com/remote.php/dav/files/alice%40example.com",
  );
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com", "a b/c"),
    "https://cloud.example.com/remote.php/dav/files/a%20b%2Fc",
  );
});

test("passes an already-complete DAV URL through untouched", () => {
  // Power users may point at a group folder or the legacy endpoint.
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com/remote.php/dav/files/bob/", "alice"),
    "https://cloud.example.com/remote.php/dav/files/bob",
  );
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com/remote.php/webdav", "alice"),
    "https://cloud.example.com/remote.php/webdav",
  );
});

test("a full DAV URL does not need a username", () => {
  assert.equal(
    nextcloudDavUrl("https://cloud.example.com/remote.php/dav/files/bob", ""),
    "https://cloud.example.com/remote.php/dav/files/bob",
  );
});

test("drops query strings, fragments and embedded credentials", () => {
  assert.equal(
    nextcloudDavUrl("https://user:pw@cloud.example.com/?a=1#frag", "alice"),
    "https://cloud.example.com/remote.php/dav/files/alice",
  );
});

test("trims surrounding whitespace from pasted values", () => {
  assert.equal(
    nextcloudDavUrl("  https://cloud.example.com  ", "  alice  "),
    "https://cloud.example.com/remote.php/dav/files/alice",
  );
});

test("rejects a missing or unusable server URL", () => {
  assert.throws(() => nextcloudDavUrl("", "alice"), /server URL is required/);
  assert.throws(() => nextcloudDavUrl(null, "alice"), /server URL is required/);
  assert.throws(() => nextcloudDavUrl("   ", "alice"), /server URL is required/);
  assert.throws(() => nextcloudDavUrl("https://", "alice"), /not valid/);
});

test("rejects non-http(s) schemes", () => {
  assert.throws(() => nextcloudDavUrl("file:///etc/passwd", "alice"), /must start with https/);
  assert.throws(() => nextcloudDavUrl("ftp://cloud.example.com", "alice"), /must start with https/);
});

test("rejects a missing username when the endpoint must be derived", () => {
  assert.throws(() => nextcloudDavUrl("https://cloud.example.com", ""), /username is required/);
  assert.throws(() => nextcloudDavUrl("https://cloud.example.com", null), /username is required/);
});
