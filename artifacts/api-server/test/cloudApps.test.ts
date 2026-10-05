import { test } from "node:test";
import assert from "node:assert/strict";
// The app's pure cloud-shortcut helper (no RN imports) — tested here because
// the Expo app has no test runner.
import { cloudAppTarget, hostToWebUrl } from "../../kkamera/lib/cloudApps.ts";

test("hostToWebUrl never opens a URL with embedded credentials", () => {
  assert.equal(hostToWebUrl("https://user:pw@nas.example.com"), "https://nas.example.com");
  assert.equal(hostToWebUrl("user:pw@nas.example.com"), "https://nas.example.com");
  assert.equal(hostToWebUrl("http://a@nas.example.com:8080/dav"), "http://nas.example.com:8080/dav");
  assert.equal(hostToWebUrl(" https://a:b@c@nas.example.com "), "https://nas.example.com");
  assert.equal(cloudAppTarget("nextcloud", "https://u:p@cloud.example.com").webUrl, "https://cloud.example.com");
  // "@" in the path / query is not userinfo and is kept.
  assert.equal(hostToWebUrl("https://nas.example.com/dav/a@b.com"), "https://nas.example.com/dav/a@b.com");
  assert.equal(hostToWebUrl("https://nas.example.com/?u=a@b"), "https://nas.example.com/?u=a@b");
});

test("hostToWebUrl keeps its existing behaviour for ordinary hosts", () => {
  assert.equal(hostToWebUrl("nas.example.com"), "https://nas.example.com");
  assert.equal(hostToWebUrl("https://nas.example.com"), "https://nas.example.com");
  assert.equal(hostToWebUrl("ftp://u@ftp.example.com"), null);
  assert.equal(hostToWebUrl("https://u@"), null);
  assert.equal(hostToWebUrl("   "), null);
  assert.equal(hostToWebUrl(null), null);
});
