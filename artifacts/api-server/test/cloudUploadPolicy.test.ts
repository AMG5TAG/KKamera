import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UPLOAD_DEADLINE_MS,
  RemoteHttpError,
  DRIVE_CHUNK_SIZE,
  ONEDRIVE_CHUNK_SIZE,
  chunkRanges,
  driveFolderQuery,
  driveNextOffset,
  driveQueryString,
  joinRemotePath,
  normalizeUploadPath,
  oneDriveItemPath,
  uploadPathSegments,
  dropboxApiArg,
  dropboxPath,
  isAllowedMimeType,
  isTlsCertError,
  isTlsUnsupportedError,
  parseConnectionIdsField,
  publicUploadError,
  uploadDeadlineMs,
} from "../src/lib/cloudUploadPolicy.ts";

test("upload deadline scales with size and is capped", () => {
  assert.equal(uploadDeadlineMs(0), 60_000);
  assert.ok(uploadDeadlineMs(10 * 1024 * 1024) > uploadDeadlineMs(1024 * 1024));
  assert.equal(uploadDeadlineMs(10 * 1024 * 1024 * 1024), MAX_UPLOAD_DEADLINE_MS);
  // The 200 MB request cap still fits inside the deadline.
  assert.ok(uploadDeadlineMs(200 * 1024 * 1024) <= MAX_UPLOAD_DEADLINE_MS);
  assert.equal(uploadDeadlineMs(NaN), 60_000);
});

test("connectionIds: absent means all; present must be a non-empty array of positive ints", () => {
  assert.deepEqual(parseConnectionIdsField(undefined), { ok: true, ids: null });
  assert.deepEqual(parseConnectionIdsField("[1,2,2]"), { ok: true, ids: [1, 2] });
  for (const bad of ["", "[]", "1", "abc", "[0]", "[-1]", "[1.5]", '["1"]', "{}", "null", "[1,null]", 42, ["1"]]) {
    assert.equal(parseConnectionIdsField(bad).ok, false, JSON.stringify(bad));
  }
});

test("mimeType allowlist", () => {
  for (const ok of ["image/jpeg", "image/heic", "video/mp4", "video/quicktime", "video/x-m4v", "image/svg+xml"]) {
    assert.equal(isAllowedMimeType(ok), true, ok);
  }
  for (const bad of ["application/pdf", "text/html", "image/", "image/jpeg\r\nX-Evil: 1", "image/jpeg; charset=x", "video/mp4\n", "", undefined, 5]) {
    assert.equal(isAllowedMimeType(bad), false, String(bad));
  }
});

test("FTPS: only certificate errors allow the unverified retry", () => {
  for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"]) {
    assert.equal(isTlsCertError(Object.assign(new Error("x"), { code })), true, code);
  }
  for (const err of [Object.assign(new Error("530 Login incorrect"), { code: 530 }), Object.assign(new Error("x"), { code: "ECONNRESET" }), new Error("timeout"), null]) {
    assert.equal(isTlsCertError(err), false);
  }
});

test("FTPS: AUTH TLS refusal is distinct from a login failure", () => {
  assert.equal(isTlsUnsupportedError({ code: 500 }), true);
  assert.equal(isTlsUnsupportedError({ code: 502 }), true);
  assert.equal(isTlsUnsupportedError({ code: 534 }), true);
  assert.equal(isTlsUnsupportedError({ code: 530 }), false);
  assert.equal(isTlsUnsupportedError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), false);
  assert.equal(isTlsUnsupportedError(new Error("x")), false);
});

test("Dropbox-API-Arg header is pure ASCII with \\u escapes", () => {
  const header = dropboxApiArg({ path: "/KKamera/Café 📷.jpg" });
  assert.match(header, /^[\x20-\x7e]+$/);
  assert.equal(header, '{"path":"/KKamera/Caf\\u00e9 \\ud83d\\udcf7.jpg"}');
  assert.deepEqual(JSON.parse(header), { path: "/KKamera/Café 📷.jpg" });
});

test("Dropbox paths always start with a single slash", () => {
  assert.equal(dropboxPath(null, "a.jpg"), "/KKamera/a.jpg");
  assert.equal(dropboxPath("KKamera", "a.jpg"), "/KKamera/a.jpg");
  assert.equal(dropboxPath("//Photos/2024/", "a.jpg"), "/Photos/2024/a.jpg");
  assert.equal(dropboxPath("/", "a.jpg"), "/a.jpg");
  assert.equal(dropboxPath("", "a.jpg"), "/a.jpg");
});

test("chunkRanges covers the buffer exactly", () => {
  assert.deepEqual(chunkRanges(10, 4), [[0, 4], [4, 8], [8, 10]]);
  assert.deepEqual(chunkRanges(8, 4), [[0, 4], [4, 8]]);
  assert.deepEqual(chunkRanges(3, 4), [[0, 3]]);
});

test("client-facing upload errors never echo raw remote detail", () => {
  const raw = new Error("connect ECONNREFUSED 10.1.2.3:443 via internal-proxy.corp");
  const msg = publicUploadError("webdav", raw);
  assert.equal(msg, "Upload to WebDAV server failed.");
  assert.doesNotMatch(msg, /10\.1\.2\.3|corp/);
  assert.match(publicUploadError("dropbox", new RemoteHttpError("Dropbox upload failed: 401 {...}", 401)), /Re-connect/);
  assert.match(publicUploadError("ftp", { code: 530, message: "530 Login incorrect" }), /username or password/);
  assert.match(publicUploadError("onedrive", new DOMException("t", "TimeoutError")), /timed out/);
  assert.match(publicUploadError("nextcloud", { status: 507 }), /out of storage/);
  assert.match(publicUploadError("webdav", { code: "ERR_SSRF_BLOCKED", message: "Blocked 169.254.169.254" }), /not allowed/);
  assert.equal(publicUploadError("mystery", new Error("x")), "Upload to cloud storage failed.");
});

test("upload path segments: slashes, backslashes, empties, dot segments", () => {
  assert.deepEqual(uploadPathSegments(null), ["KKamera"]);
  assert.deepEqual(uploadPathSegments(undefined), ["KKamera"]);
  assert.deepEqual(uploadPathSegments(""), []);
  assert.deepEqual(uploadPathSegments("/"), []);
  assert.deepEqual(uploadPathSegments("/Photos/KKamera"), ["Photos", "KKamera"]);
  assert.deepEqual(uploadPathSegments("Photos/KKamera/"), ["Photos", "KKamera"]);
  assert.deepEqual(uploadPathSegments("//Photos///KKamera//"), ["Photos", "KKamera"]);
  assert.deepEqual(uploadPathSegments("\\Photos\\KKamera\\"), ["Photos", "KKamera"]);
  assert.deepEqual(uploadPathSegments("/a/./b/../c"), ["a", "b", "c"]); // ".." never escapes
  assert.deepEqual(uploadPathSegments(" /My Photos / 2024 "), ["My Photos", "2024"]);
});

test("normalizeUploadPath keeps absolute vs relative (FTP) and canonicalises the rest", () => {
  assert.equal(normalizeUploadPath(null), "/KKamera");
  assert.equal(normalizeUploadPath("/Photos/KKamera/"), "/Photos/KKamera");
  assert.equal(normalizeUploadPath("dir"), "dir");
  assert.equal(normalizeUploadPath("dir/sub/"), "dir/sub");
  assert.equal(normalizeUploadPath("\\dir\\sub"), "/dir/sub");
  assert.equal(normalizeUploadPath("/"), "/");
  assert.equal(normalizeUploadPath("///"), "/");
  assert.equal(normalizeUploadPath(""), "");
});

test("joinRemotePath never doubles slashes", () => {
  assert.equal(joinRemotePath([], "a.jpg"), "/a.jpg");
  assert.equal(joinRemotePath(["Photos", "KKamera"], "a.jpg"), "/Photos/KKamera/a.jpg");
  assert.equal(dropboxPath("/", "a.jpg"), "/a.jpg");
  assert.equal(dropboxPath("Photos\\KKamera\\", "a.jpg"), "/Photos/KKamera/a.jpg");
});

test("Drive query quoting escapes quotes and backslashes; folder query scopes to the parent", () => {
  assert.equal(driveQueryString("it's"), "'it\\'s'");
  assert.equal(driveQueryString("a\\b"), "'a\\\\b'");
  const q = driveFolderQuery("Bob's", "root");
  assert.ok(q.startsWith("name='Bob\\'s' and 'root' in parents"));
  assert.ok(q.includes("mimeType='application/vnd.google-apps.folder'"));
  assert.ok(q.includes("trashed=false"));
});

test("Drive resumable: chunk size is a 256 KiB multiple; Range header parsing", () => {
  assert.equal(DRIVE_CHUNK_SIZE % (256 * 1024), 0);
  assert.equal(driveNextOffset(null), 0);
  assert.equal(driveNextOffset("bytes=0-524287"), 524288);
  assert.equal(driveNextOffset("garbage"), 0);
});

test("OneDrive: fragment size is a 320 KiB multiple under 60 MiB; path segments encoded", () => {
  assert.equal(ONEDRIVE_CHUNK_SIZE % (320 * 1024), 0);
  assert.ok(ONEDRIVE_CHUNK_SIZE < 60 * 1024 * 1024);
  assert.equal(oneDriveItemPath(["KKamera"], "a.jpg"), "root:/KKamera/a.jpg:");
  assert.equal(oneDriveItemPath([], "a.jpg"), "root:/a.jpg:");
  assert.equal(
    oneDriveItemPath(["My Photos", "#1?"], "100% café.jpg"),
    "root:/My%20Photos/%231%3F/100%25%20caf%C3%A9.jpg:",
  );
});
