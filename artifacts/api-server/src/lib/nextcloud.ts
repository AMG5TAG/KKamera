/**
 * Nextcloud connection helpers.
 *
 * Nextcloud (and ownCloud) speak plain WebDAV, but the endpoint is not the
 * server URL the user knows — files live under
 * `https://<server>/remote.php/dav/files/<username>/`. Asking users to work
 * that out themselves is the whole reason the generic "WebDAV Server" option is
 * awkward for Nextcloud, so we store the *server* URL they copied out of their
 * browser and derive the DAV endpoint here.
 *
 * Pure and dependency-free (unit-tested in test/nextcloud.test.ts) — the SSRF
 * guard and the actual transport stay in cloudUpload.ts.
 */

/** Nextcloud's DAV entry points. Anything containing one is already a DAV URL. */
const DAV_MARKER = "/remote.php/";

/**
 * Derive the WebDAV files endpoint for a Nextcloud account.
 *
 * Accepts what a user is likely to paste: a bare host (`cloud.example.com`), a
 * full origin (`https://cloud.example.com`), a subfolder install
 * (`https://example.com/nextcloud`), or an already-complete DAV URL — which is
 * passed through so power users can point at a group folder or the legacy
 * `/remote.php/webdav` endpoint.
 *
 * @param rawHost  Server URL as entered by the user. Defaults to https:// when no scheme is given.
 * @param username Nextcloud login the app password belongs to.
 * @param port     Optional explicit port; ignored when `rawHost` already carries one.
 */
export function nextcloudDavUrl(rawHost: string | null | undefined, username: string | null | undefined, port?: number | null): string {
  const { base, path } = parseServerUrl(rawHost, port, "Nextcloud server URL");

  if (path.toLowerCase().includes(DAV_MARKER)) return `${base}${path}`;

  const user = (username ?? "").trim();
  if (!user) throw new Error("Nextcloud username is required");
  return `${base}${path}/remote.php/dav/files/${encodeURIComponent(user)}`;
}

/**
 * Normalise a generic WebDAV server URL (Synology, QNAP, Apache mod_dav, …).
 *
 * Unlike Nextcloud the path is the DAV collection itself, so it is kept as-is.
 * Defaults to https:// when no scheme is given, and applies the connection's
 * separate `port` field when the URL has none (Synology's WebDAV server
 * listens on 5006/5005, not 443/80, so ignoring it made those NASes
 * unreachable).
 */
export function webdavBaseUrl(rawHost: string | null | undefined, port?: number | null): string {
  const { base, path } = parseServerUrl(rawHost, port, "WebDAV server URL");
  return `${base}${path}`;
}

/** Shared URL parsing for the DAV helpers above. */
function parseServerUrl(
  rawHost: string | null | undefined,
  port: number | null | undefined,
  label: string,
): { base: string; path: string } {
  const host = (rawHost ?? "").trim();
  if (!host) throw new Error(`${label} is required`);

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${label} is not valid`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must start with https://`);
  }
  // An explicit port in the URL always wins over the separate port field.
  if (port && !url.port) url.port = String(port);

  // `origin` drops any query string, fragment and embedded user:pass, so only
  // the scheme/host/port survive from whatever was pasted.
  return { base: url.origin, path: url.pathname.replace(/\/+$/, "") };
}
