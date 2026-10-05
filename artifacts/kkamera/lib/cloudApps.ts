/**
 * Mapping from a cloud-connection type to the app / website that shows the
 * user's uploaded files, used by the camera's cloud shortcut.
 *
 * NOTE ON DETECTION: we deliberately do NOT use `Linking.canOpenURL` to decide
 * whether the app is installed. On iOS it returns false for any scheme not
 * listed in `LSApplicationQueriesSchemes`, and on Android 11+ package
 * visibility makes it return false without a `<queries>` manifest entry —
 * neither of which Expo's managed config exposes cleanly. Attempting
 * `openURL(appUrl)` and falling back on rejection works on both platforms with
 * no native config at all: iOS only gates *querying*, not opening, and Android
 * throws ActivityNotFoundException when nothing handles the intent.
 */

export interface CloudAppTarget {
  /** Human name for messages ("Open Google Drive"). */
  label: string;
  /** Deep link that launches the provider's app, if it has one. */
  appUrl: string | null;
  /** Browser fallback when the app isn't installed. */
  webUrl: string | null;
}

/**
 * Drop any "user:pass@" userinfo from a URL / bare host. The server rejects
 * such hosts now, but older connections may still carry one — never hand
 * credentials to the browser (history, referrers, screenshots).
 */
function stripUserinfo(url: string): string {
  const m = url.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/?#\\]*)(.*)$/i);
  if (!m) return url;
  const [, scheme = "", authority = "", rest = ""] = m;
  const at = authority.lastIndexOf("@");
  return at === -1 ? url : `${scheme}${authority.slice(at + 1)}${rest}`;
}

/** Coerce a user-entered host into a browsable https URL, or null. */
export function hostToWebUrl(host: string | null | undefined): string | null {
  const h = host?.trim() ? stripUserinfo(host.trim()) : "";
  if (!h || /^[a-z][a-z0-9+.-]*:\/\/$/i.test(h)) return null;
  if (/^https?:\/\//i.test(h)) return h;
  // Any other explicit scheme (ftp://, sftp://…) isn't browsable — skip it
  // rather than guess.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) return null;
  return `https://${h}`;
}

/**
 * Where a connection's files live. `host` is only meaningful for the
 * self-hosted types and is ignored for the OAuth providers.
 */
export function cloudAppTarget(type: string, host?: string | null): CloudAppTarget {
  switch (type) {
    case "googledrive":
      return { label: "Google Drive", appUrl: "googledrive://", webUrl: "https://drive.google.com/drive/my-drive" };
    case "onedrive":
      return { label: "OneDrive", appUrl: "ms-onedrive://", webUrl: "https://onedrive.live.com" };
    case "dropbox":
      return { label: "Dropbox", appUrl: "dropbox://", webUrl: "https://www.dropbox.com/home" };
    case "nextcloud":
      return { label: "Nextcloud", appUrl: "nextcloud://", webUrl: hostToWebUrl(host) };
    case "webdav":
      // No universal WebDAV client scheme — go straight to the server's web UI
      // when the host looks browsable.
      return { label: "your WebDAV server", appUrl: null, webUrl: hostToWebUrl(host) };
    case "ftp":
      // FTP hosts aren't browsable over https in general; don't guess.
      return { label: "your FTP server", appUrl: null, webUrl: null };
    default:
      return { label: "your cloud", appUrl: null, webUrl: null };
  }
}

export interface ConnectionLike {
  id: number;
  type: string;
  active: boolean;
  host?: string | null;
}

/**
 * Pick the connection the cloud shortcut should open.
 *
 * Prefers the user's chosen upload destinations (in the order the server
 * returns them) and otherwise falls back to the first active connection, so the
 * button lands on the account captures are actually going to.
 */
export function pickCloudConnection<T extends ConnectionLike>(
  connections: T[] | undefined,
  targetIds: number[] | undefined,
): T | null {
  const active = (connections ?? []).filter(c => c.active);
  if (active.length === 0) return null;
  if (targetIds && targetIds.length > 0) {
    const preferred = active.find(c => targetIds.includes(c.id));
    if (preferred) return preferred;
  }
  return active[0] ?? null;
}
